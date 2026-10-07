import java.util.Properties
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Upload key for Play: path and alias in keystore.properties (gitignored),
// passwords only from the environment, never on disk.
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    val uploadPassword = System.getenv("SILENTSILO_UPLOAD_STORE_PASSWORD")
    if (keystoreProperties.containsKey("storeFile") && uploadPassword != null) {
        signingConfigs {
            create("upload") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                keyAlias = keystoreProperties.getProperty("keyAlias", "upload")
                storePassword = uploadPassword
                keyPassword = System.getenv("SILENTSILO_UPLOAD_KEY_PASSWORD") ?: uploadPassword
            }
        }
    }
    namespace = "com.silentsilo.mobile"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.silentsilo.mobile"
        minSdk = 31
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfigs.findByName("upload")?.let { signingConfig = it }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

// The Kotlin half of rustls-platform-verifier. From 0.2.0 its crate no longer
// carries it; upstream publishes it on a GitHub branch instead. It is kept
// here, under vendor/maven, so a build fetches nothing and runs only the
// bytes checked in, and cargo's lockfile still decides the version: a
// version with no copy here, or a copy that does not match its hash, stops
// the build. To move to a new version, add its .aar and .pom from
// https://github.com/rustls/rustls-platform-verifier/tree/maven-archive/android-release-support/maven
// after checking them against the .sha1 published beside them, and its
// SHA-256 below.
val rustlsVerifierSha256 = mapOf(
    "0.2.0" to "aa021794230fbc2f0be355999e2cf67398dd563de066a2e17001ffbd0b69101b",
)

repositories {
    maven {
        url = uri(file("../vendor/maven"))
        metadataSources.artifact()
    }
}

fun rustlsPlatformVerifierVersion(): String {
    val json = providers.exec {
        workingDir = file("../../../")
        commandLine(
            "cargo", "metadata", "--format-version", "1",
            "--filter-platform", "aarch64-linux-android",
            "--manifest-path", file("../../../Cargo.toml").absolutePath,
        )
    }.standardOutput.asText.get()
    @Suppress("UNCHECKED_CAST")
    val packages = (groovy.json.JsonSlurper().parseText(json) as Map<String, Any>)["packages"] as List<Map<String, Any>>
    val version = packages.first { it["name"] == "rustls-platform-verifier-android" }["version"] as String
    val expected = rustlsVerifierSha256[version]
        ?: throw GradleException("rustls-platform-verifier-android $version has no vendored copy in vendor/maven; see build.gradle.kts")
    val aar = file("../vendor/maven/org/rustls/rustls-platform-verifier/$version/rustls-platform-verifier-$version.aar")
    val actual = MessageDigest.getInstance("SHA-256")
        .digest(aar.readBytes()).joinToString("") { byte -> "%02x".format(byte) }
    if (actual != expected) {
        throw GradleException("vendor/maven: rustls-platform-verifier-$version.aar does not match its SHA-256")
    }
    return version
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // The passkey provider API (Android 14+).
    implementation("androidx.credentials:credentials:1.5.0")
    // Certificate checks for S3 and WebDAV, called from Rust.
    implementation("org.rustls:rustls-platform-verifier:${rustlsPlatformVerifierVersion()}")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")