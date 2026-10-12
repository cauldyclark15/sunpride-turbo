# SP-0140: R8 (full mode) rules for the field app's release builds (beta, perf).
# Libraries ship their own consumer rules (Room, WorkManager, OkHttp, CameraX, Play services,
# SQLCipher); these are the extra guarantees this app relies on.

# SQLCipher's native library looks up Java classes, fields and callbacks by name over JNI.
# Its consumer rules cover the known members; keep the whole package so a native lookup can
# never hit a renamed or removed member (it is small, and a miss would crash on the phone).
-keep class net.zetetic.database.** { *; }

# Readable crash stack traces in Play/OS reports: keep line numbers, hide source file names.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
