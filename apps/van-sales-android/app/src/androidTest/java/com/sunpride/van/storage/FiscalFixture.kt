package com.sunpride.van.storage

import org.json.JSONArray
import org.json.JSONObject

/** F-018/F-019: unmistakably unfiled test-only authorization, never a real permit. */
object FiscalFixture {
    const val ALLOCATION = "36ac2874-cc3f-4330-b1b4-ad9b67f10646"
    fun add(snapshot: JSONObject, device: String) {
        val registration = JSONObject().put("entityName","SAMPLE COMPANY").put("branchName","Sample Cebu")
            .put("tin","SAMPLE TIN").put("address","Sample address").put("permitReference",JSONObject.NULL)
            .put("sample",true).put("status","sample_not_filed").put("taxBasisPoints",1200)
        val range = JSONObject().put("allocationId",ALLOCATION).put("seriesId","a9125710-69d5-4c59-8dba-43e648688077")
            .put("documentType","sales_invoice").put("prefix","SAMPLE-SI").put("firstSerial","1").put("lastSerial","100")
            .put("nextSerial","1").put("deviceId",device).put("effectiveTo",JSONObject.NULL).put("registration",registration)
        snapshot.getJSONObject("policy").put("fiscal",JSONObject().put("required",true).put("ranges",JSONArray().put(range)))
    }
}
