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
                buildConfigField("String", "CONVEX_SITE_URL", quoted(endpoint("SUNPRIDE_${name.uppercase()}_CONVEX_SITE_URL")))
                buildConfigField("String", "CONVEX_URL", quoted(endpoint("SUNPRIDE_${name.uppercase()}_CONVEX_URL")))
            }
        }
    }
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
    // Frozen cross-language P-256 vectors are read in place; never hand-copied into this project.
    sourceSets.getByName("test").resources.srcDir(
        rootProject.file("../../packages/domain-contracts/fixtures/mobile-v1/crypto")
    )
    sourceSets.getByName("test").resources.srcDir(
        rootProject.file("../../packages/domain-contracts/fixtures/mobile-v1")
    )
    sourceSets.getByName("androidTest").assets.srcDir("schemas")
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
    kapt(libs.room.compiler)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.test.manifest)
    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.org.json) // real org.json on the JVM; android.jar only has stubs
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
