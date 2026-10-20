import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    id("org.jetbrains.kotlin.kapt")
}

val local = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
fun endpoint(key: String): String = (providers.gradleProperty(key).orNull
    ?: providers.environmentVariable(key).orNull
    ?: local.getProperty(key)
    ?: "").trim()
fun quoted(value: String) = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""
fun homePath(path: String) = if (path.startsWith("~/")) System.getProperty("user.home") + path.substring(1) else path

// Every flavor defaults to the Sunpride server origin; override with SUNPRIDE_<FLAVOR>_API_ORIGIN.
val betaBuild = endpoint("SUNPRIDE_BETA_BUILD").ifEmpty { "1" }.toIntOrNull()?.takeIf { it in 1..9999 }
    ?: error("SUNPRIDE_BETA_BUILD must be a whole number from 1 to 9999")
// The beta signing key lives OUTSIDE the repo; this properties file (chmod 600) holds its path and password.
val betaSigning = Properties().apply {
    val file = File(homePath(endpoint("SUNPRIDE_BETA_SIGNING_PROPERTIES").ifEmpty { "~/.sunpride-keys/field-beta.properties" }))
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.sunpride.field"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.sunpride.field"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildFeatures { compose = true; buildConfig = true }
    flavorDimensions += "environment"
    productFlavors {
        listOf("dev", "staging", "prod").forEach { name ->
            create(name) {
                dimension = "environment"
                applicationIdSuffix = ".$name"
                resValue("string", "app_name", "Sunpride Field (${name.replaceFirstChar { it.uppercase() }})")
                buildConfigField("String", "SUNPRIDE_API_ORIGIN", quoted(endpoint("SUNPRIDE_${name.uppercase()}_API_ORIGIN").ifEmpty { "https://sunpride.cauldnclark.com" }))
                buildConfigField("String", "WEB_URL", quoted(endpoint("SUNPRIDE_${name.uppercase()}_WEB_URL")))
            }
        }
        create("beta") {
            dimension = "environment"
            applicationIdSuffix = ".beta"
            versionCode = betaBuild
            versionName = "1.0.0-beta.$betaBuild"
            resValue("string", "app_name", "Sunpride Field (Beta)")
            buildConfigField("String", "SUNPRIDE_API_ORIGIN", quoted(endpoint("SUNPRIDE_BETA_API_ORIGIN").ifEmpty { "https://sunpride.cauldnclark.com" }))
            // "Report an issue" opens <web>/issues/new; hidden when this is empty.
            buildConfigField("String", "WEB_URL", quoted(endpoint("SUNPRIDE_BETA_WEB_URL").ifEmpty { "https://sunpride.cauldnclark.com" }))
        }
    }
    signingConfigs {
        if (betaSigning.getProperty("storeFile") != null) create("beta") {
            storeFile = File(homePath(betaSigning.getProperty("storeFile")))
            storePassword = betaSigning.getProperty("storePassword")
            keyAlias = betaSigning.getProperty("keyAlias")
            keyPassword = betaSigning.getProperty("keyPassword")
        }
    }
    // Only betaRelease takes the beta key (the debug build type keeps the debug key).
    productFlavors.getByName("beta").signingConfig = signingConfigs.findByName("beta")
    buildTypes {
        // SP-0140: release builds (beta APKs, perf) are shrunk for cheap phones: R8 full mode
        // (code shrink + optimise), unused resources removed, and only the ARM libraries phones use
        // (x86 is emulator-only and was ~13 MB of SQLCipher). Debug builds and device tests are unchanged.
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
        }
        // SP-0140: the release build, debug-signed under its own package (`<app>.perf`) so
        // `scripts/measure-performance.sh` can measure it on the reference phone without
        // replacing the installed dev app. Never shipped.
        create("perf") {
            initWith(getByName("release"))
            applicationIdSuffix = ".perf"
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")
            resValue("string", "app_name", "Sunpride Field (Perf)")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isReturnDefaultValues = true }
    sourceSets.getByName("main").java.srcDir(rootProject.file("../../packages/callflow-native/src/main/kotlin"))
    sourceSets.getByName("test").java.srcDir(rootProject.file("../../packages/callflow-native/src/test/kotlin"))
    // F-616: one catalogue and scanner implementation for both Android products.
    sourceSets.getByName("main").java.srcDir(rootProject.file("../../packages/native-catalogue/src/main/java"))
    sourceSets.getByName("main").assets.srcDir(rootProject.file("../api/assets"))
    sourceSets.getByName("test").java.srcDir(rootProject.file("../../packages/native-catalogue/src/test/java"))
    sourceSets.getByName("androidTest").java.srcDir(rootProject.file("../../packages/native-catalogue/src/androidTest/java"))
    @Suppress("UnstableApiUsage")
    defaultConfig.javaCompileOptions.annotationProcessorOptions.arguments["room.schemaLocation"] =
        "$projectDir/schemas"
    // Frozen cross-language P-256 vectors are read in place; never hand-copied into this project.
    sourceSets.getByName("test").resources.srcDir(
        rootProject.file("../../packages/domain-contracts/fixtures/mobile-v1/crypto")
    )
    sourceSets.getByName("test").resources.srcDir(
        rootProject.file("../../packages/domain-contracts/fixtures/mobile-v1")
    )
    // ANA-010: the suggested-order sample response shared with iOS, read in place.
    sourceSets.getByName("test").resources.srcDir(
        rootProject.file("../../packages/domain-contracts/fixtures/suggested-order")
    )
    sourceSets.getByName("androidTest").assets.srcDir("schemas")
    // F-007/F-024 opt-in physical proof: throwaway local-only account, never release assets.
    System.getenv("SUNPRIDE_INTEGRITY_FIELD_PROOF_DIR")?.let { sourceSets.getByName("androidTest").assets.srcDir(it) }
    // F-312/F-024: one integrity implementation shared by both Android products.
    sourceSets.getByName("main").java.srcDir(rootProject.file("../../packages/android-integrity/src/main/java"))
    sourceSets.getByName("androidTest").java.srcDir(rootProject.file("../../packages/android-integrity/src/androidTest/java"))
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    implementation(libs.core)
    implementation(libs.activity.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    implementation(libs.sqlcipher)
    implementation(libs.sqlite)
    implementation(libs.work.runtime)
    // AND-016 visit photo evidence: CameraX preview + still capture.
    implementation(libs.camera.core)
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    implementation(libs.camera.view)
    implementation(libs.zxing.core) // F-616: reuse the van offline barcode decoder.
    // SP-0128 fingerprint/face sign-in: BiometricPrompt (needs a FragmentActivity).
    implementation(libs.biometric)
    // SP-0140: a FragmentActivity that accepts androidx.activity permission request codes (see libs.versions.toml).
    implementation(libs.fragment)
    // Work-day sharing and visit capture use Android's platform fused provider (no Play-services dependency).
    kapt(libs.room.compiler)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.test.manifest)
    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.org.json) // real org.json on the JVM; android.jar only has stubs
    androidTestImplementation(libs.work.testing)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.test.junit4)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.espresso.core)
    androidTestImplementation(libs.room.testing)
    // Match Room's generated schema serializers to the runtime ABI during migration validation.
    androidTestImplementation(libs.serialization.core)
}

configurations.matching { it.name.contains("AndroidTest", ignoreCase = true) }.configureEach {
    resolutionStrategy.force("org.jetbrains.kotlinx:kotlinx-serialization-core:${libs.versions.serialization.get()}")
    resolutionStrategy.force("org.jetbrains.kotlinx:kotlinx-serialization-json:${libs.versions.serialization.get()}")
    resolutionStrategy.force("org.jetbrains.kotlinx:kotlinx-serialization-json-jvm:${libs.versions.serialization.get()}")
}
