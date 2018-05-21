package com.se

import org.apache.spark.sql.SparkSession
import org.apache.spark.{SparkConf, SparkContext}
import com.datastax.spark.connector._
import com.datastax.spark.connector.cql.CassandraConnector
import com.datastax.driver.dse.DseSession


/**
  * Created by michaelraney on 3/3/18.
  */
object DSAppCorrelations {

  def main(args: Array[String]): Unit = {

     val conf = new SparkConf(true).setAppName("DSAppCorrelations").set("spark.cassandra.connection.host", "127.0.0.1")
     val sc = new SparkContext(conf)
     val spark = SparkSession.builder().getOrCreate()

     val instrRDD = sc.cassandraTable("finance","financial_instruments").select("stock_symbols")
       .where("instrument = 'unusual_correlations'")
       .map(row => (row.getString(0)) )
       .flatMap (row => row.split(',') )
       .map( row => row.split('|') )
       .map {case Array(s1: String, s2: String) => (s1, s2)}

     instrRDD.collect().foreach {
        case (s1: String, s2: String) =>
        {  //println(s1 + " - " + s2)
           val stock_pair = s1+"|"+s2
           var lastCorr_10_Val = 0L;
           sc.cassandraTable("finance","correlations")
            .select("epoch_seconds").where("symbol_pair = ? and corr_10 > 0", stock_pair).limit(1)
            .map(  row => row.getLong(0) ).collect().foreach { case (l) => (lastCorr_10_Val = l)  }
           var lastCorr_50_Val = 0L;
           sc.cassandraTable("finance","correlations")
            .select("epoch_seconds").where("symbol_pair = ? and corr_50 > 0", stock_pair).limit(1)
            .map(  row => row.getLong(0) ).collect().foreach { case (l) => (lastCorr_50_Val = l)  }
           var lastCorr_100_Val = 0L;
           sc.cassandraTable("finance","correlations")
            .select("epoch_seconds").where("symbol_pair = ? and corr_100 > 0", stock_pair).limit(1)
            .map(  row => row.getLong(0) ).collect().foreach { case (l) => (lastCorr_100_Val = l)  }
           println ( "lastCorr_10_Val / lastCorr_50_Val / lastCorr_100_Val: " + lastCorr_10_Val + " / " + lastCorr_50_Val + " / " + lastCorr_100_Val)
           var minOfThem = math.min( lastCorr_10_Val, math.min(lastCorr_50_Val, lastCorr_100_Val))
           println ( "stock pair / min of them is: " +  stock_pair + " / " + minOfThem  )

           // We just add 100 so we use < rather than <= ):
           val earliestEpochSec = minOfThem + 100L

           var stock_1_RDD = sc.cassandraTable("finance","daily_stock_prices")
            .select("epoch_seconds","price").where("symbol = ? and epoch_seconds > ?", s1, earliestEpochSec)
            .map(  row => (row.getLong(0), row.getDouble(1))  )
           val stock_1_2ndPart_RDD = sc.cassandraTable("finance","daily_stock_prices")
             .select("epoch_seconds","price").where("symbol = ? and epoch_seconds < ?", s1, earliestEpochSec)
             .limit(100)
             .map(  row => (row.getLong(0), row.getDouble(1))  )
           stock_1_RDD = stock_1_RDD.union(stock_1_2ndPart_RDD)
           val stock_1_zip_RDD = (stock_1_RDD.zipWithIndex()).map({ case ((e,p),idx) => (idx,(e,p)) }).cache()

           var stock_2_RDD = sc.cassandraTable("finance","daily_stock_prices")
            .select("epoch_seconds","price").where("symbol = ? and epoch_seconds > ?", s2, earliestEpochSec)
            .map(  row => (row.getLong(0), row.getDouble(1))  )
           val stock_2_2ndPart_RDD = sc.cassandraTable("finance","daily_stock_prices")
             .select("epoch_seconds","price").where("symbol = ? and epoch_seconds < ?", s2, earliestEpochSec)
             .limit(100)
             .map(  row => (row.getLong(0), row.getDouble(1))  )
           stock_2_RDD = (stock_2_RDD.union(stock_2_2ndPart_RDD))
           val stock_2_zip_RDD = (stock_2_RDD.zipWithIndex()).map({ case ((e,p),idx) => (idx,(e,p)) }).cache()

           // very important: if minOfThem == 0 we must set it to epoch_seconds of the 100th record from the end of stock_1_zip_RDD
           if (minOfThem == 0) {
             val tempCount = stock_1_zip_RDD.count()
             stock_1_zip_RDD.collect().map( {case (idx,(e,p)) => ( if(idx == (tempCount - 100) ) minOfThem = e) }  )
             println("minOfThem was 0 but is now: " + minOfThem )
           }

           val connector = CassandraConnector(spark.sparkContext.getConf)
           connector.withSessionDo ({ s =>
              // 10 day correlation
              var lastEpoch = 0L
              var index = 0
              stock_1_zip_RDD.collect().map( { case (idx,(e,p)) => ( if(idx == index) lastEpoch = e) }  )
              val session = s.asInstanceOf[DseSession]
              var ps = session.prepare("insert into finance.correlations (symbol_pair, epoch_seconds, corr_10) values (?,?,?) using ttl ?" )
              while  (lastEpoch > minOfThem ){
                 //// let's try here subsets of 10
                 var subset_1 = stock_1_zip_RDD.filter ( { case (idx,(e,p)) => ( idx >= index && idx < (index + 10) ) } )
                 var subset_2 = stock_2_zip_RDD.filter ( { case (idx,(e,p)) => ( idx >= index && idx < (index + 10) ) } )
                 stock_1_zip_RDD.collect().map( {case (idx,(e,p)) => ( if(idx == index) lastEpoch = e) }  )
                 //println("Stock 1 / Stock 2 ---------> : " + s1 + " / " + s2 + " from epoch: " + lastEpoch)
                 val corr_val = corr(subset_1.collect(), subset_2.collect())
                 //println("corr_val: " + corr_val)
                 val boundStmt = ps.bind( (s1+"|"+s2), new java.lang.Long(lastEpoch), new java.lang.Double(corr_val), new java.lang.Integer(63504000) )
                 session.execute(boundStmt)

                index = index + 1
              }

              // 50 day correlation
              lastEpoch = 0L
              index = 0
              stock_1_zip_RDD.collect().map( { case (idx,(e,p)) => ( if(idx == index) lastEpoch = e) }  )
              ps = session.prepare("insert into finance.correlations (symbol_pair, epoch_seconds, corr_50)  values (?,?,?) using ttl ?" )
              while  (lastEpoch > minOfThem ){
                 //// let's try here subsets of 10
                 var subset_1 = stock_1_zip_RDD.filter ( { case (idx,(e,p)) => ( idx >= index && idx < (index + 50) ) } )
                 var subset_2 = stock_2_zip_RDD.filter ( { case (idx,(e,p)) => ( idx >= index && idx < (index + 50) ) } )
                 stock_1_zip_RDD.collect().map( {case (idx,(e,p)) => ( if(idx == index) lastEpoch = e) }  )
                 //println("Stock 1 / Stock 2 ---------> : " + s1 + " / " + s2 + " from epoch: " + lastEpoch)
                 val corr_val = corr(subset_1.collect(), subset_2.collect())
                 //println("corr_val: " + corr_val)
                 val boundStmt = ps.bind( (s1+"|"+s2), new java.lang.Long(lastEpoch), new java.lang.Double(corr_val), new java.lang.Integer(63504000) )
                 session.execute(boundStmt)

                 index = index + 1
              }

              // 100 day correlation
              lastEpoch = 0L
              index = 0
              stock_1_zip_RDD.collect().map( { case (idx,(e,p)) => ( if(idx == index) lastEpoch = e) }  )
              ps = session.prepare("insert into finance.correlations (symbol_pair, epoch_seconds, corr_100)  values (?,?,?) using ttl ?" )
              while  (lastEpoch > minOfThem ){
                 //// let's try here subsets of 10
                 var subset_1 = stock_1_zip_RDD.filter ( { case (idx,(e,p)) => ( idx >= index && idx < (index + 100) ) } )
                 var subset_2 = stock_2_zip_RDD.filter ( { case (idx,(e,p)) => ( idx >= index && idx < (index + 100) ) } )
                 stock_1_zip_RDD.collect().map( {case (idx,(e,p)) => ( if(idx == index) lastEpoch = e) }  )
                 //println("Stock 1 / Stock 2 ---------> : " + s1 + " / " + s2 + " from epoch: " + lastEpoch)
                 val corr_val = corr(subset_1.collect(), subset_2.collect())
                 //println("corr_val: " + corr_val)
                 val boundStmt = ps.bind( (s1+"|"+s2), new java.lang.Long(lastEpoch), new java.lang.Double(corr_val), new java.lang.Integer(63504000) )
                 session.execute(boundStmt)

                 index = index + 1
              }

           })

        }

     }

      def corr(a_arr: Array[(Long,(Long,Double))], b_arr: Array[(Long,(Long,Double))]): Double = {
         val a_length = a_arr.length
         val a_avg = a_arr.map({case(l,(v1,v2)) => v2 }).sum / a_length
         val b_avg = b_arr.map({case(l,(v1,v2)) => v2 }).sum / a_length
         // Covariance a, b
         val a_minus_a_avg = a_arr.map({case(l,(v1,v2)) => (l,v2 - a_avg) })
         val b_minus_b_avg = b_arr.map({case(l,(v1,v2)) => (l,v2 - b_avg) })
         val a_minus_a_avg_joined_b_minus_b_avg = a_minus_a_avg.zip(b_minus_b_avg).map ({ case (left, right) => (left._1, left._2 * right._2)  })
         val cov_a_b = a_minus_a_avg_joined_b_minus_b_avg.map({ case (k, v) => v }).sum / (a_length - 1)
         //println("cov_a_b: " + cov_a_b)

         // Variance a, b
         val a_minus_a_avg_joined_itself = a_minus_a_avg.zip(a_minus_a_avg).map ({ case (left, right) => (left._1, left._2 * right._2)  })
         val b_minus_b_avg_joined_itself = b_minus_b_avg.zip(b_minus_b_avg).map ({ case (left, right) => (left._1, left._2 * right._2)  })
         val var_a = a_minus_a_avg_joined_itself.map({ case(k,v) => v }).sum / (a_length - 1)
         val var_b = b_minus_b_avg_joined_itself.map({ case(k,v) => v }).sum / (a_length - 1)
         val std_dev_a = math.sqrt(var_a)
         val std_dev_b = math.sqrt(var_b)
         //println("std_dev_a / var_b: " + std_dev_a + " / " + std_dev_b)
         val corr_coef = cov_a_b / (std_dev_a * std_dev_b)
         //println("corr_coef: " + corr_coef)

         if (std_dev_a == 0.0 || std_dev_b == 0.0) return 0 // think about this

         return corr_coef

      }

      System.exit(0)
  }


}