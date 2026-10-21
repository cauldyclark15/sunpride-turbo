package com.sunpride.field.auth

import com.sunpride.integrity.AppUpdateRules
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class AppUpdateRulesTest {
 private val cert="a".repeat(64)
 private fun release()=JSONObject().put("id",UUID.randomUUID().toString()).put("packageName","com.sunpride.field.beta")
  .put("versionCode",2).put("sizeBytes",100).put("sha256","b".repeat(64)).put("signerSha256",cert)
 @Test fun F006_updateRequiresTheSamePackageNewerVersionAndInstalledSigner() {
  val r=release()
  AppUpdateRules.archive(r,"com.sunpride.field.beta",1,setOf(cert),"com.sunpride.field.beta",2,setOf(cert))
  for(action in listOf<()->Unit>(
   {AppUpdateRules.release(r,"com.sunpride.van.beta",1,setOf(cert))},
   {AppUpdateRules.release(r,"com.sunpride.field.beta",2,setOf(cert))},
   {AppUpdateRules.release(r,"com.sunpride.field.beta",1,setOf("c".repeat(64)))},
   {AppUpdateRules.archive(r,"com.sunpride.field.beta",1,setOf(cert),"com.sunpride.field.beta",3,setOf(cert))},
   {AppUpdateRules.archive(r,"com.sunpride.field.beta",1,setOf(cert),"com.sunpride.field.beta",2,setOf("c".repeat(64)))}
  ))try {action();fail("must reject untrusted update")}catch(_:IllegalArgumentException){}
 }
}
