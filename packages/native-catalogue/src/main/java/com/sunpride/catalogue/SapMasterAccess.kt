package com.sunpride.catalogue

import android.content.Context
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** F-004: write-ahead grant revocation prevents old retained rows reopening after a server denial.
 * Cache bytes stay in the host app's existing SQLCipher DB; preferences contain no master data/token. */
interface SapMasterGrants {
 fun allowed(key:String):Boolean
 fun revoke(key:String):Boolean
 fun permit(key:String):Boolean
}
class SapMasterAccess(private val grants:SapMasterGrants) {
 constructor(context:Context):this(object:SapMasterGrants {
  private val prefs=context.getSharedPreferences("sap_master_read_grants",Context.MODE_PRIVATE)
  override fun allowed(key:String)=prefs.getBoolean(key,false)
  override fun revoke(key:String)=prefs.edit().remove(key).commit()
  override fun permit(key:String)=prefs.edit().putBoolean(key,true).commit()
 })
 companion object {private val locks=ConcurrentHashMap<String,Any>()}
 fun cached(key:String,read:()->String?,isCurrent:()->Boolean):JSONObject? {
  if(!isCurrent() || !grants.allowed(key))return null
  val raw=read() ?: return null
  return JSONObject(raw).takeIf {isCurrent() && grants.allowed(key)}
 }
 fun refresh(key:String,binding:SapMasterMirror.Binding,read:()->String?,write:(String)->Unit,
     pull:(JSONObject)->JSONObject,isCurrent:()->Boolean,denied:(Exception)->Boolean):JSONObject = synchronized(locks.getOrPut(key){Any()}) {
  check(isCurrent()) {"Master authorization changed"}
  val previous=cached(key,read,isCurrent)
  // If revocation cannot be persisted, do NOT make a network request that could deny authority.
  check(grants.revoke(key)) {"Could not protect the saved master copy"}
  val updated=try {SapMasterMirror.refresh(binding,previous,pull,isCurrent)}
  catch(e:Exception) {
   // Transport trouble is not withdrawal. Restore only the exact previously authorized projection.
   if(e !is kotlinx.coroutines.CancellationException && !denied(e) && previous!=null && isCurrent())
    check(grants.permit(key)) {"Saved master copy remains unavailable"}
   throw e
  }
  check(isCurrent()) {"Master authorization changed"}
  write(updated.toString())
  check(isCurrent()) {"Master authorization changed"}
  check(grants.permit(key)) {"Master copy saved but read permission could not be retained"}
  check(isCurrent()) {"Master authorization changed"}
  updated
 }
}
