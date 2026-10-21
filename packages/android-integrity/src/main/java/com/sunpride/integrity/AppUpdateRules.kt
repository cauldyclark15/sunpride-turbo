package com.sunpride.integrity

import org.json.JSONObject
import java.util.UUID

/** F-006: shared pure facts used before download and after Android parses the actual APK. */
object AppUpdateRules {
 fun release(r:JSONObject,packageName:String,installedVersion:Long,installedSigners:Set<String>) {
  UUID.fromString(r.getString("id"))
  require(r.getString("packageName")==packageName && r.getLong("versionCode")>installedVersion)
  require(r.getLong("sizeBytes") in 1..(120L*1024*1024))
  require(Regex("[0-9a-f]{64}").matches(r.getString("sha256")) && Regex("[0-9a-f]{64}").matches(r.getString("signerSha256")))
  require(installedSigners.size==1 && installedSigners==setOf(r.getString("signerSha256"))) {"Published update uses a different signer"}
 }
 fun archive(r:JSONObject,packageName:String,installedVersion:Long,installedSigners:Set<String>,archivePackage:String,archiveVersion:Long,archiveSigners:Set<String>) {
  release(r,packageName,installedVersion,installedSigners)
  require(archivePackage==packageName && archiveVersion==r.getLong("versionCode") && archiveSigners==installedSigners) {"APK package, version or signer changed"}
 }
}
