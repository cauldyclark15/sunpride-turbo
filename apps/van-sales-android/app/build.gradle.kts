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

// SP-0125 beta: endpoints fall back to DEV (with a build warning) until a beta deployment exists.
val betaRequested = gradle.startParameter.taskNames.any { it.contains("beta", ignoreCase = true) }
val betaBuild = endpoint("SUNPRIDE_BETA_BUILD").ifEmpty { "1" }.toIntOrNull()?.takeIf { it in 1..9999 }
    ?: error("SUNPRIDE_BETA_BUILD must be a whole number from 1 to 9999")
fun betaEndpoint(key: String): String = endpoint("SUNPRIDE_BETA_$key").ifEmpty {
    if (betaRequested) logger.warn("WARNING: SUNPRIDE_BETA_$key is not set; the van beta build uses the DEV value.")
    endpoint("SUNPRIDE_DEV_$key")
}
// The beta signing key lives OUTSIDE the repo; this properties file (chmod 600) holds its path and password.
val betaSigning = Properties().apply {
    val file = File(homePath(endpoint("SUNPRIDE_VAN_BETA_SIGNING_PROPERTIES").ifEmpty { "~/.sunpride-keys/van-beta.properties" }))
    if (file.exists()) file.inputStream().use { load(it) }
}

// Sunpride Van Sales POS (ADR-010): its own app, never the field app with POS switched on.
// Same Convex deployment endpoints as the field app (SUNPRIDE_<FLAVOR>_CONVEX_*).
android {
    namespace = "com.sunpride.van"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.sunpride.van"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildFeatures { compose = true; buildConfig = true; aidl = true }
    flavorDimensions += "environment"
    productFlavors {
        listOf("dev", "staging", "prod").forEach { name ->
            create(name) {
                dimension = "environment"
                applicationIdSuffix = ".$name"
                resValue("string", "app_name", "Sunpride Van (${name.replaceFirstChar { it.uppercase() }})")
                buildConfigField("String", "CONVEX_SITE_URL", quoted(endpoint("SUNPRIDE_${name.uppercase()}_CONVEX_SITE_URL")))
                buildConfigField("String", "CONVEX_URL", quoted(endpoint("SUNPRIDE_${name.uppercase()}_CONVEX_URL")))
                buildConfigField("String", "WEB_URL", quoted(endpoint("SUNPRIDE_${name.uppercase()}_WEB_URL")))
                buildConfigField("boolean", "BETA", "false")
            }
        }
        // SP-0125: the hand-delivered tester build. Release only (see androidComponents below).
        create("beta") {
            dimension = "environment"
            applicationIdSuffix = ".beta"
            versionCode = betaBuild
            versionName = "1.0.0-beta.$betaBuild"
            resValue("string", "app_name", "Sunpride Van Sales (Beta)")
            buildConfigField("String", "CONVEX_SITE_URL", quoted(betaEndpoint("CONVEX_SITE_URL")))
            buildConfigField("String", "CONVEX_URL", quoted(betaEndpoint("CONVEX_URL")))
            // "Report an issue" opens <web>/issues/new; hidden when this is empty.
            buildConfigField("String", "WEB_URL", quoted(endpoint("SUNPRIDE_BETA_WEB_URL")))
            buildConfigField("boolean", "BETA", "true")
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
    // Only betaRelease takes the beta key; without the key file the APK stays unsigned and the
    // build script refuses to publish it.
    productFlavors.getByName("beta").signingConfig = signingConfigs.findByName("beta")
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isReturnDefaultValues = true }
    @Suppress("UnstableApiUsage")
    defaultConfig.javaCompileOptions.annotationProcessorOptions.arguments["room.schemaLocation"] =
        "$projectDir/schemas"
    // Frozen cross-language contract fixtures are read in place, never copied.
    sourceSets.getByName("test").resources.srcDir(
        rootProject.file("../../packages/domain-contracts/fixtures/mobile-v1/crypto")
    )
    sourceSets.getByName("test").resources.srcDir(
        rootProject.file("../../packages/domain-contracts/fixtures/van-v1")
    )
    sourceSets.getByName("test").resources.srcDir(rootProject.file("../../packages/domain-contracts/schemas"))
    sourceSets.getByName("androidTest").assets.srcDir("schemas")
    sourceSets.getByName("androidTest").assets.srcDir(
        rootProject.file("../../packages/domain-contracts/fixtures/van-v1")
    )
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

// Only the dev flavor has a debug build: the handheld test script installs every
// install*Debug task, and one instrumentation run per device is what we want.
androidComponents {
    beforeVariants { variant ->
        if (variant.buildType == "debug" && variant.flavorName != "dev") variant.enable = false
    }
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
    // VAN scanner fallback: CameraX preview + ZXing decode (Apache-2.0, no Play services).
    implementation(libs.camera.core)
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    implementation(libs.camera.view)
    implementation(libs.zxing.core)
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
    androidTestImplementation(libs.serialization.core)
}

configurations.matching { it.name.contains("AndroidTest", ignoreCase = true) }.configureEach {
    resolutionStrategy.force("org.jetbrains.kotlinx:kotlinx-serialization-core:${libs.versions.serialization.get()}")
    resolutionStrategy.force("org.jetbrains.kotlinx:kotlinx-serialization-json:${libs.versions.serialization.get()}")
    resolutionStrategy.force("org.jetbrains.kotlinx:kotlinx-serialization-json-jvm:${libs.versions.serialization.get()}")
}

// Unflavored aliases so `./gradlew assembleDebug testDebugUnitTest lintDebug` works with the
// single dev debug variant.
tasks.register("lintDebug") { dependsOn("lintDevDebug") }
