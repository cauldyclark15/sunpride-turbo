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

# Rhino 1.9.1 (scheme engine, packages/native-promotions) references java.beans only in
# JavaToJSONConverters' default converter for wrapped *Java objects* inside JSON.stringify.
# java.beans does not exist on Android, and NativeSchemes never exposes Java objects to the script
# (initSafeStandardObjects, ClassShutter denies everything, input/output are plain JSON strings),
# so that path is unreachable. Exact classes only; any other missing class still fails the build.
-dontwarn java.beans.BeanDescriptor
-dontwarn java.beans.BeanInfo
-dontwarn java.beans.IntrospectionException
-dontwarn java.beans.Introspector
-dontwarn java.beans.PropertyDescriptor

# Rhino loads its regex engine via ServiceLoader.load(<non-constant Class>) from
# META-INF/services/org.mozilla.javascript.RegExpLoader. R8 can't see that statically and would
# drop the implementation, silently breaking JS regular expressions in the scheme engine.
-keep class org.mozilla.javascript.regexp.RegExpLoaderImpl { <init>(); }
