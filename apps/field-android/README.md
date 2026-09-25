# Sunpride Field Android

Standalone Kotlin/Jetpack Compose shell for the native field app. No network or sign-in is implemented in this slice. The Sign in button is deliberately disabled and sync status stays **Offline — not signed in**. The debug build includes a Design tokens preview.

## Requirements and run

JDK 21 (Android Studio JBR), Android SDK API 36 and build-tools 36, a Google APIs ARM64 API 36 emulator image, and Gradle wrapper (included). From this directory:

```sh
export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
export ANDROID_HOME="$HOME/Library/Android/sdk"
cp local.properties.example local.properties # replace placeholders with non-secret DEV URLs
./gradlew :app:assembleDevDebug :app:testDevDebugUnitTest :app:connectedDevDebugAndroidTest :app:lintDevDebug
"$ANDROID_HOME/platform-tools/adb" install -r app/build/outputs/apk/dev/debug/app-dev-debug.apk
"$ANDROID_HOME/platform-tools/adb" shell am start -n com.sunpride.field.dev/com.sunpride.field.MainActivity
```

URLs may instead come from `SUNPRIDE_DEV_CONVEX_SITE_URL` and `SUNPRIDE_DEV_CONVEX_URL` environment variables or Gradle properties; staging/prod use the same names with their respective uppercase prefix. Priority: Gradle property, environment, local.properties. Missing/invalid endpoints show a visible configuration error instead of crashing. Only HTTPS `.convex.site`/`.convex.cloud` origins are accepted, except HTTP localhost and emulator `10.0.2.2` for development. Never put credentials or tokens in properties. Flavor IDs are `com.sunpride.field.dev`, `.staging`, `.prod`; each has a labeled launcher name. minSdk 29 (Android 10) avoids obsolete OS/security behavior while covering modern field devices; target/compileSdk 36. Neither the native app nor this directory has a package.json, so Turbo does not treat it as a JS workspace.

## Design and accessibility

Palette follows `packages/ui/docs/DESIGN.md`: red `#EE1C25`, yellow `#FEF200`, success `#2E9D59`, danger `#C8102E`, ink `#18181B`, light canvas `#F5F5F5` and white surface. The shared CSS `index.css` has a slightly different `#FAFAFA` canvas; the design specification's light `#F5F5F5` is used. Dark canvas/surface are `#060606`/`#181818`. Brand red is retained as a swatch; light primary text/actions use a darker `#AB151C` for WCAG normal-text contrast. Status is labeled in text, not color alone. Spacing is multiples of 4 dp; radii are 8/12 dp. The web bundles Mulish Variable but no redistributable native font license was confirmed here, so Android system default is used with scalable sp type.

`ContrastTest` calculates WCAG sRGB ratios and enforces at least 4.5:1 for every text/background pair in the shell and preview, including the disabled button label. Ratios (normal text): light shell 16.25, surface 17.72, status/disabled 4.63, primary 7.17, error 5.88; dark shell 19.75, surface 17.31, status/disabled 12.13, primary 6.39, error 6.26; yellow 15.11, success 5.13, danger 5.73. The saturated brand-red swatch has no overlaid text because neither dark nor light text reaches 4.5:1 there. Compose tests exercise light, dark and 2.0 font scale. No backend connectivity, offline cache, authentication, device bind, or financial workflows are implied by this scaffold.
