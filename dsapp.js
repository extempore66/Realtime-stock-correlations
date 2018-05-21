// Before you deploy it on Linux issue this command to set the time zone to New York so you work with the local stock exchange: >export TZ=America/New_York
const async = require('async');
const cluster = require('cluster');
const fs = require('fs');
const https = require('https');
const dse = require('dse-driver');
const distance = dse.types.distance;
const options = {
   contactPoints: ['127.0.0.1'],
   pooling: {
      coreConnectionsPerHost: { [distance.local]: 20} 
   }
};

const client = new dse.Client( options );
client.connect().then(function () {
  console.log('Connected to cluster with %d host(s): %j', client.hosts.length, client.hosts.keys());
});

var workers = [];

// cache for prices
let allStockPricesObj = {};

// for clearing intervals
var current_prices_interval = 0;
		
// load the stock array and the correlated stock pairs arrays
let allStocksOnMaster = ["^DJI","^GSPC","^IXIC"]; // Market Indexes - Dow, Nasdq, S&P. The stocks below will be added to this
let allCorrelatedPairs = ["GM|PIO","C|SUP","DIS|XLI","COKE|ELP","VZ|CPK","AMZN|WCN","F|WOOD","BA|MDT","YUM|WES","MCD|SO","MSFT|ABG",
       "NKE|TGI","ANF|SFLY","VIA|PBJ"];

const port = 80; // to use ports below 1024 you must run this with sudo, e.g. "sudo node yahoo_hist_prices.js"

if (cluster.isMaster) {
    //console.log('Test of existence of MSFT: ' + allStockPricesObj['MSFT'] )
    //if (! allStockPricesObj['MSFT'] ){
    //   allStockPricesObj['MSFT'] = 100;
    //}
    //console.log('Test of existence of MSFT after assignment: ' + allStockPricesObj['MSFT'] )
    //console.log(`starting master with pid: ${process.pid}` );
    const os = require('os');
	  const cpuNo = os.cpus().length;
	  for (var i = 0; i < cpuNo; i++) {
	     let worker = cluster.fork(); // this returns the worker object ref which can be pushed into an array if you want to send msgs to it
       workers.push(worker);
	  }
    cluster.on( 'exit', function(worker, code, signal) { console.log('worker ' + worker.process.pid + ' died'); client.shutdown(); } );
    process.on('SIGINT', function() { 
       console.log("Caught interrupt signal - saving allStockPricesObj to file"); 
       fs.writeFile('./data/all_stock_prices.txt', JSON.stringify(allStockPricesObj), (err) => {  
           // throws an error, you could also catch it here
           if (err) throw err;
           process.exit();
       });

       client.shutdown(); 
    });

    // Load these above pairs in master. The solution is the master will retrieve and maintain the current price on each of these stocks 
    // in cassandra while the workers have 2 tasks: retrieve historical prices at the end of the day and field the http request from 
    // clients and/or push the current pricess to web clients through socket.io
    for ( const id in allCorrelatedPairs ) { 
       let stockPair = (allCorrelatedPairs[id]).split('|');
       for (const indivStock in stockPair) {
          allStocksOnMaster.splice(0,0,stockPair[indivStock]);
       }
    } 
    // send the arrays to each worker
    for (const id in workers){
       workers[id].send({ msg: 'stock_arrays', allStocks: allStocksOnMaster, allCorrelatedPairs: allCorrelatedPairs });
    }


    // check every 12 hours. Yahoo initially sets epoch time to 4pm on the current day but eventually it sets it
    // to 9:30 am on the current day. check often enough and you will have the right epoch number
    check_historical_prices(allStocksOnMaster); // this guy is defined towards the file end - sends messages to workers
    setInterval(function(){ check_historical_prices(allStocksOnMaster); }, (12 * 3600000) );
    current_prices_interval = setInterval(function(){ check_current_prices(allStocksOnMaster); }, /*(Math.floor(Math.random() * 11) + 10000) */ 10000 );
    console.log('current_prices_interval: ' + current_prices_interval);

    // this one will be taken out, it's just to showcase we have all the prices
    //setInterval( function(){  for (let prop in allStockPricesObj){ console.log('Price of ' + prop + ' is ' + allStockPricesObj[prop]); }  } , 30000);
    setInterval( function(){ 
        for (const id in workers){ workers[id].send({ msg: 'realtime_prices_object', allStockPricesObj: allStockPricesObj}); } 
    }, 10000 );

}
else {
    const express = require('express');
    const app = express();

    let allStocks = [];
    let allCorrelatedPairs = [];
    process.on('message', function(message) {
        //console.log(`Worker ${process.pid} receives message '${message.msg}' and stock pair is: ` +  message.stock_pair + 
        //  ' epoch_seconds: ' + message.epoch_seconds);
        if (message.msg == 'stock_arrays'){
           allStocks = message.allStocks;
           allCorrelatedPairs = message.allCorrelatedPairs;
        }
        if (message.msg == 'realtime_prices_object') {
           allStockPricesObj = message.allStockPricesObj;
        }
    });

    //var httpServer = require('http').createServer(app).listen(port);
    var httpServer = require('http').Server(app).listen(port);

    // The main job of the workers is to respond to http requests from web clients build the cache of allStockPricesObj and 
    // push realtime data to clients through socket.io
    // record any ip we come from
    app.use( '/', express.static(__dirname) );
    app.use(express.json());
    //app.use(express.static(path.join(__dirname, 'public')));
    //app.use('/scripts', express.static(__dirname + '/public/javascripts/'));
    //app.use('/images', express.static(__dirname + '/public/images/'));
    //app.use('/stylesheets', express.static(__dirname + '/public/stylesheets/'));
    app.setMaxListeners(0); // no limits

    // needed because firefox would complain about returns from post being malformed (mime type was missing)
    app.post('/*', function(req, res, next) {
       res.contentType('application/json');
       next();
    });
    app.get('/', function(req, res, next) {
       // functionality to record visiting ip addresses
       var utc = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
       res.send('UTC: ' + utc);
       next();
    });

    app.post("/getstockpair", function(req, res){
       //console.log('req.body: ' + JSON.stringify(req.body));
       let corrStockPair = req.body.stockPair;
       let query = 'select symbol, toDate((epoch_seconds * 1000)) as date, price from finance.daily_stock_prices  where symbol = ?';
       let corr_query = 'select symbol_pair, toDate((epoch_seconds * 1000)) as date, corr_10, corr_50, corr_100 from finance.correlations \
         where symbol_pair = ?';
       (async function(){
          try {
              const result_1 = await client.execute(query, [ corrStockPair.split('|')[0] ], { prepare: true } );
              const result_2 = await client.execute(query, [ corrStockPair.split('|')[1] ], { prepare: true } ); 
              const result_3 = await client.execute(corr_query, [ corrStockPair ], { prepare: true } ); 
              
              console.log('result_1.length / result_2.length / result_3.length: ' + result_1.rows.length + " / " + result_2.rows.length + " / " +
                result_3.rows.length);
              let chartData = [];
              // the shortest array is result_3 because it's correlations so they start at 100 days after the individual stocks' first day
              for (let row = result_3.rows.length - 1; row > -1 ; row--){
                   chartData[row] = ({ date:result_3.rows[row].date, corr_10:result_3.rows[row].corr_10, corr_50:result_3.rows[row].corr_50,
                      corr_100:result_3.rows[row].corr_100, value_1:result_1.rows[row].price, value_2:result_2.rows[row].price });

                   //console.log(' Symbol Pair: ' + result_3.rows[row].symbol_pair + ' date: ' + chartData[row].date + 
                   //' corr_10: ' + chartData[row].corr_10 + ' corr_50: ' + chartData[row].corr_50 + ' corr_100: ' + chartData[row].corr_100  );
                   //console.log(' Symbol: ' + result_2.rows[row].symbol + ' date: ' + chartData[row].date + ' price: ' + chartData[row].value_2  );
                   //console.log(' Symbol: ' + result_1.rows[row].symbol + ' date: ' + chartData[row].date + ' price: ' + chartData[row].value_1  );
              }
              chartData = chartData.reverse();
              let retObj = {'chartData':chartData};
              res.header(200);
              res.end( JSON.stringify(retObj) );
              //serverSocket.emit('connection_ack', {'allCorrelatedPairs':allCorrelatedPairs, 'chartData':chartData} );
          } catch(err) {console.log('Error in io.on(connection ...) async function: ' + err)}
       })();

    });

    // the latest version on socket.io requires different initialization
    var io = require('socket.io')(httpServer);
    io.on('connection', function(serverSocket){
       //console.log('a user connected');
       //emit and broadcast
       // sending to the client    serverSocket.emit('hello', 'can you hear me?', 1, 2, 'abc');
       // sending to all clients except sender   serverSocket.broadcast.emit('broadcast', 'hello friends!');
       // sending to all clients in 'game' room, including sender  io.in('game').emit('big-announcement', 'the game will start soon')
       // sending privately to   serverSocket.to(<socketid>).emit('hey', 'I just met you');

       //serverSocket.emit('connection_ack', {'serverSocketId':serverSocket.id, 'clusterWorkerId':cluster.worker.id} );
       // let's get the prices here for the first pair and also their correlation
      
       console.log( allCorrelatedPairs[0].split('|')[0] + ' / ' + allCorrelatedPairs[0].split('|')[1] )
       let query = 'select symbol, toDate((epoch_seconds * 1000)) as date, price from finance.daily_stock_prices  where symbol = ?';
       let corr_query = 'select symbol_pair, toDate((epoch_seconds * 1000)) as date, corr_10, corr_50, corr_100 from finance.correlations \
         where symbol_pair = ?';
       (async function(){
          try {
              const result_1 = await client.execute(query, [ allCorrelatedPairs[0].split('|')[0] ], { prepare: true } );
              const result_2 = await client.execute(query, [ allCorrelatedPairs[0].split('|')[1] ], { prepare: true } ); 
              const result_3 = await client.execute(corr_query, [ allCorrelatedPairs[0] ], { prepare: true } ); 
              
              console.log('result_1.length / result_2.length / result_3.length: ' + result_1.rows.length + " / " + result_2.rows.length + " / " +
                result_3.rows.length);
              let chartData = [];
              // the shortest array is result_3 because it's correlations so they start at 100 days after the individual stocks' first day
              for (let row = result_3.rows.length - 1; row > -1 ; row--){
                   chartData[row] = ({ date:result_3.rows[row].date, corr_10:result_3.rows[row].corr_10, corr_50:result_3.rows[row].corr_50,
                      corr_100:result_3.rows[row].corr_100, value_1:result_1.rows[row].price, value_2:result_2.rows[row].price });

                   //console.log(' Symbol Pair: ' + result_3.rows[row].symbol_pair + ' date: ' + chartData[row].date + 
                   //' corr_10: ' + chartData[row].corr_10 + ' corr_50: ' + chartData[row].corr_50 + ' corr_100: ' + chartData[row].corr_100  );
                   //console.log(' Symbol: ' + result_2.rows[row].symbol + ' date: ' + chartData[row].date + ' price: ' + chartData[row].value_2  );
                   //console.log(' Symbol: ' + result_1.rows[row].symbol + ' date: ' + chartData[row].date + ' price: ' + chartData[row].value_1  );
              }
              chartData = chartData.reverse();
              serverSocket.emit('connection_ack', {'allCorrelatedPairs':allCorrelatedPairs, 'chartData':chartData} );
          } catch(err) {console.log('Error in io.on(connection ...) async function: ' + err)}
       })();
      
       setInterval( function(){ 
           io.emit('realtime_prices', {'allStockPricesObj':allStockPricesObj} );
       }, 10000 );

    }); // end io.on('connection',

    

} // end of  "else (if cluster.isMaster)"

//startEpochTime, endEpochTime are seconds since Dec 31 1970 and for Yahoo finance ideally time has to be set to 9:30AM - local
function getStockHistory(argStock, startEpochTime, endEpochTime) {
   console.log(`Processing historical data for '${argStock}'`);
   const url = encodeURI('https://finance.yahoo.com/quote/' + argStock + '/history?period1=' + startEpochTime + 
      '&period2=' + endEpochTime + '&interval=1d&filter=history&frequency=1d');
    //'https://finance.yahoo.com/quote/GOOG/history?period1=1460727000&period2=1523937600&interval=1d&filter=history&frequency=1d'
   https.get(url, (resp) => {
      // ok the logic here is this: add chunks to the data and check for the occurrence of   "HistoricalPriceStore":{"prices":[
      // when that occurs trim data to begin with that and startlooking for the end bracket: ']'. When that occurs trim your data 
      // to include that and your data is complete. Ignore the rest of the chunks arriving
      let data = '';
      let hist_price_store_ocurred = 0;
      let the_end_braket_occured = 0;
      let last_left_curly_bracket_pos = 0;
      let last_right_curly_bracket_pos = 0;
      let temp_obj = null;

       // A chunk of data has been recieved.
      resp.on('data', (chunk) => {
          if (the_end_braket_occured < 1) {
           data += chunk;
          }
          if (data.indexOf('"HistoricalPriceStore":{"prices":[') > -1){
             data = data.substring( ( data.indexOf('"HistoricalPriceStore":{"prices":[') + '"HistoricalPriceStore":{"prices":['.length - 1 )  );
             hist_price_store_ocurred = 1;
             //console.log('Date, Open, High, Low, Close, Volume, Adj Close' +  '\n');
             
             //check if the end bracket - ']' - might be here as well
             if (data.indexOf(']') > -1){
                data = data.substring( 0, (data.indexOf(']') + 1) );
                the_end_braket_occured = 1;
             }
          }
          else {
             if (hist_price_store_ocurred > 0){
                if (data.indexOf(']') > -1){
                   data = data.substring( 0, (data.indexOf(']') + 1) );
                   the_end_braket_occured = 1;
                }
             }
          }
          
          // Let's try to process data as it comes in, i.e. parsing the stream for { and } denoting a node / javascript object
          // This 'while' construct precludes infinite loops (sort of) as it exits when there are no more   {  or  }
          // Very Important: we only want to process data if "HistoricalPriceStore":{"prices":[  has occurred
          if( hist_price_store_ocurred > 0){
             // interesting thing I missed initially: if data ends with a left braket pos '{'' but no right bracket has occurred
             var left_curly_bracket_pos = data.indexOf('{', last_left_curly_bracket_pos ); // we start at pos 0 (initial left_curly_bracket_pos value)
             //console.log('first left_curly_bracket_pos: ' + left_curly_bracket_pos);
             var right_curly_bracket_pos = -1;
             while(left_curly_bracket_pos > -1){
                   last_left_curly_bracket_pos = left_curly_bracket_pos;
                   right_curly_bracket_pos = data.indexOf( '}', last_left_curly_bracket_pos );
                   if(right_curly_bracket_pos == -1){
                      break;  
                   }
                   last_right_curly_bracket_pos = right_curly_bracket_pos;
                   temp_obj = JSON.parse( data.substring(last_left_curly_bracket_pos, (last_right_curly_bracket_pos + 1)) );

                   // Here is wht happens here, historical prices can come back with 2 values for the same date, one for 9:30am
                   // which is the value at closing time and another value with after hours with different price, volumes, etc
                   // Solution:we discard the data if the hours and minutes of epoch time is not 9:30 am
                   // Another thing which happens is there are dividends interspersed with price i.e. objects in the format:
                   // {"amount":0.308645,"date":1515162600,"type":"DIVIDEND","data":0.308645}. These objects result in a price of 0
                   // and must be skipped i.e if temp_obj.type == "DIVIDEND" exists, skip it (or if temp_obj[type] exists)
                   let localDt = new Date(temp_obj.date * 1000);
                   //if (temp_obj.type){
                   //   console.log(argStock + ' -> localDt: ' + localDt + ' getHours:' + localDt.getHours() + ' getMinutes: ' + localDt.getMinutes() + 
                   //    ' temp_obj.type defined: ' + temp_obj.type);
                   //}
                   
                   if( (localDt.getHours() == 9 && localDt.getMinutes() == 30) && (!temp_obj.type)) { // what the hell will we do if yahoo ever changes that??!!!
                      const insQuery = 'insert into finance.daily_stock_prices (symbol, epoch_seconds , price ) values (?, ?, ?) using ttl ?';
                      client.execute(insQuery, [ argStock, temp_obj.date, (Math.round(temp_obj.adjclose * 100) / 100), 63504000 ], 
                        { prepare: true } )
                      .catch( function (err) { console.log('Error in insert query catch: ' + err); } );
                      
                      //console.log(temp_obj.date + ', ' + (Math.round(temp_obj.open * 100) / 100) + ', ' + (Math.round(temp_obj.high * 100) / 100) + 
                      //  ', ' + (Math.round(temp_obj.low * 100) / 100) + ', ' + (Math.round(temp_obj.close * 100) / 100) + ', ' + temp_obj.volume + 
                      //  ', ' + (Math.round(temp_obj.adjclose * 100) / 100) ); 
                   }
                   
                   left_curly_bracket_pos = data.indexOf( '{', last_right_curly_bracket_pos );
                   
                   // the only messed up thing here is if the chunk ended with a right bracket } in which case the last processed object will
                   // be duplicated. left_curly_bracket_pos becomes -1 the loop is exited but when we re-enter  last_left_curly_bracket_pos and 
                   // last_right_curly_bracket_pos will have already been processed. so we take care of this particular case below:
                   // the last piece, detect if data contains the right square bracket ']'. if it does set positions of the curly bracket past the length
                   // of data so there are no duplicaitons of the last javascript object
                   if (data[data.length - 1] == '}' || the_end_braket_occured > 0){
                      //last_left_curly_bracket_pos++;
                      last_left_curly_bracket_pos = (data.length - 1); // same as above
                   }
             }
          }
          
      });
      
      // The whole response has been received. Print out the result.
      resp.on('end', () => {
         //console.log('Resp end occurred but it's ok because we processed the stream as it came in');
      });

   }).on("error", (err) => {
       console.log("Error from getStockHistory: " + err.message);
       //process.exit(0);
   });

}

//startEpochTime, endEpochTime are seconds since Dec 31 1970 and for Yahoo finance ideally time has to be set to 9:30AM - local
function getStockCurrentPrice(argStock) {
   //console.log(`Processing current prices for '${argStock}'`);
   const url = encodeURI('https://finance.yahoo.com/quote/' + argStock + '?p=' + argStock);
   https.get(url, (resp) => {
      // ok the logic here is this: add chunks to the data and check for the occurrence of   "HistoricalPriceStore":{"prices":[
      // when that occurs trim data to begin with that and startlooking for the end bracket: ']'. When that occurs trim your data 
      // to include that and your data is complete. Ignore the rest of the chunks arriving
      let data = '';
      let sourceIntervalFound = 0;
      let regularMarketPriceFound = 0;
      let regularMarketChangeFound = 0;
      let gotThePrice = 0;
      let gotTheChange = 0;
      let thePrice = null;
      let theChange = null;

      const sourceIntervalPattern = '"' + argStock + '":{"sourceInterval":';
      const regularMarketPricePattern = '"regularMarketPrice":{"raw":';
      const regularMarketChangePattern = '"regularMarketChange":{"raw":';

      //"SYMBOL":{"sourceInterval":   is unique after which the first "regularMarketPrice":{"raw": should be the current price

      // A chunk of data has been recieved.
      resp.on('data', (chunk) => {
          if (gotThePrice < 1 || gotTheChange < 1) {
             data += chunk;
             let sourceIntervalIdx = data.indexOf(sourceIntervalPattern);
             if ( sourceIntervalIdx > -1){
                data = data.substring( sourceIntervalIdx );
                sourceIntervalFound = 1;
                //check if regularMarketPrice immediately after it occurred - might be here as well
                let regularMarketPriceAfterSourceIntervalIdx = data.indexOf(regularMarketPricePattern);
                if (regularMarketPriceAfterSourceIntervalIdx  > -1){
                   regularMarketPriceFound = 1;
                   //data = data.substring(regularMarketPriceAfterSourceIntervalIdx);
                   // get the comma immediately after
                   let commaAfterRegMarketPrIdx = data.indexOf(',', regularMarketPriceAfterSourceIntervalIdx + regularMarketPricePattern.length);
                   if (commaAfterRegMarketPrIdx > -1){
                      thePrice = data.substring(regularMarketPriceAfterSourceIntervalIdx + regularMarketPricePattern.length, commaAfterRegMarketPrIdx);
                      gotThePrice = 1;
                      console.log(`Price for '${argStock}' is ${thePrice}`);
                      // save it to allStockPricesObj
                      // allStockPricesObj[argStock] = data;
                   }
                }
                // now for the market change:
                let regularMarketChangeAfterSourceIntervalIdx = data.indexOf(regularMarketChangePattern);
                if (regularMarketChangeAfterSourceIntervalIdx  > -1){
                   regularMarketChangeFound = 1;
                   //data = data.substring(regularMarketPriceAfterSourceIntervalIdx);
                   // get the comma immediately after
                   let commaAfterRegMarketChIdx = data.indexOf(',', regularMarketChangeAfterSourceIntervalIdx + regularMarketChangePattern.length);
                   if (commaAfterRegMarketChIdx > -1){
                      theChange = data.substring(regularMarketChangeAfterSourceIntervalIdx + regularMarketChangePattern.length, commaAfterRegMarketChIdx);
                      gotTheChange = 1;
                      console.log(`Change for '${argStock}' is ${theChange}`);
                   }
                }

                if(thePrice && theChange){
                   allStockPricesObj[argStock] = thePrice + '|' + theChange;
                }

             }// if ( sourceIntervalIdx > -1){ ...
             

          } // end of if (gotThePrice < 1 || gotTheChange < 1) { ...}
          

      });
      // The whole response has been received. Print out the result.
      resp.on('end', () => {
         //console.log('Resp end occurred but it\'s ok because we processed the stream as it came in');
         //process.exit(0);
      });
      resp.on('error', (err) => {
         console.log("Error in getStockCurrentPrice Response: " + err.message);
      });

   }).on("error", (err) => {
       console.log("Error in getStockCurrentPrice GET: " + err.message);
       //process.exit(0);
   });

}

// now get on with setting up stock pairs, etc. This is called periodically in the master - every 2 days after being called once on master startup
function check_historical_prices(argStockArray) {
       const date = new Date();
       const today_9_30_am = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9, 30, 0);
       const today_9_30_am_epoch = ((today_9_30_am.getTime()) / 1000); // we want seconds not milliseconds
       const two_years_ago_9_30_am_epoch = ( (new Date( (date.getFullYear() - 2), date.getMonth(), date.getDate(), 9, 30, 0)).getTime() ) / 1000;
   
       const query = 'select symbol, epoch_seconds, price from finance.daily_stock_prices where symbol = ? limit 1';
       for (const id in argStockArray){
                // first get the latest date (epoch seconds) from DSE
                //const query = 'select symbol, epoch_seconds, price from finance.daily_stock_prices where symbol = ? limit 1';
                client.execute(query, [ argStockArray[id] ], { prepare: true } )
                .then((result) => {
                    if (result.rows.length > 0){
                       //console.log(' Symbol: ' + result.rows[0].symbol + ' epoch_seconds: ' +  result.rows[0].epoch_seconds);
                       // if the last price date is obsolete we retrieve history since last date / epoch seconds
                       if ( today_9_30_am_epoch > result.rows[0].epoch_seconds){
                          let fromEpochSeconds = Number(result.rows[0].epoch_seconds) + 86400;
                          getStockHistory( argStockArray[id], fromEpochSeconds, today_9_30_am_epoch );
                       }
                    } 
                    else {
                       //console.log(' Result set for ' + duoStock[id] + ' returned no rows so today 9:30am is: ' + 
                       //  `${new Date(message.epoch_seconds * 1000)}` + ' and epoch seconds is: ' + today_9_30_am_epoch );
                       getStockHistory( argStockArray[id], two_years_ago_9_30_am_epoch, today_9_30_am_epoch ); 
                    }
                    //return Promise.resolve(result.rows);  // we commented this out cause we need no further Promise processing
                })
                .catch( function (err) { console.log('Error in Promise catch: ' + err); } );
       }

}

function check_current_prices(argStockArray){
   // if the duoStock is not epmty and if we are inside NY market hours get the prices. Add the holidays for skipping (in the future)
   // for the sake of testing skip the   conditions
   clearInterval(current_prices_interval);

   let localDt = new Date();
   const today_9_30_am = new Date(localDt.getFullYear(), localDt.getMonth(), localDt.getDate(), 9, 30, 0);
   const today_9_30_am_epoch = today_9_30_am.getTime();
   const today_4_00_pm = new Date(localDt.getFullYear(), localDt.getMonth(), localDt.getDate(), 16, 00, 0);
   const today_4_00_pm_epoch = today_4_00_pm.getTime();
   
   if( (localDt > today_9_30_am) && (localDt < today_4_00_pm_epoch) ) { 
      //console.log('Getting current stock prices (because we are within trading hours)');
      for (const individualStock in argStockArray) {
         getStockCurrentPrice(argStockArray[individualStock]);
      } 
   }
   //else {
      //console.log('Not getting current stock prices Date / Time: ' + localDt + ' (because we are outside NY Stock Exchange trading hours)'  );
   //}

   current_prices_interval = setInterval(function(){ check_current_prices(allStocksOnMaster); }, /*(Math.floor(Math.random() * 16) + 15000)*/ 10000 );
}
