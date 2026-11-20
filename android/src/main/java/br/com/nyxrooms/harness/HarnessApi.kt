package br.com.nyxrooms.harness

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.net.URLEncoder
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

const val ORIGIN = "https://nyxrooms.com"
const val BASE = "$ORIGIN/codex-agent"
private const val COOKIE = "__Secure-codex_session"

fun enc(value: String): String = URLEncoder.encode(value, "UTF-8")
fun obj(vararg pairs: Pair<String, Any?>) = JSONObject().apply { pairs.forEach { (k, v) -> put(k, v ?: JSONObject.NULL) } }
fun JSONArray?.objects() = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
fun JSONArray?.strings() = if (this == null) emptyList() else (0 until length()).mapNotNull { opt(it)?.toString() }
fun JSONObject.str(key: String) = if (isNull(key)) "" else optString(key)

class SessionExpired : Exception("Sua sessão expirou. Entre novamente.")

/** HTTPS client for the Harness API. The session cookie is kept encrypted with an Android Keystore key. */
class HarnessApi(context: Context) {
    private val prefs = context.getSharedPreferences("session", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (store.getKey(COOKIE, null) as? SecretKey) ?: KeyGenerator.getInstance("AES", "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(COOKIE, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes("GCM").setEncryptionPaddings("NoPadding").build())
            generateKey()
        }
    }

    private var cookie = runCatching {
        val bytes = Base64.decode(prefs.getString("encrypted", "") ?: "", Base64.NO_WRAP)
        if (bytes.size < 13) "" else Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            String(doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
        }
    }.getOrDefault("")

    /** Cookie string for the in-app WebView preview (same session, never logged). */
    /** Cookie request header for the background event stream. */
    fun cookieHeader() = if (cookie.isEmpty()) "" else "$COOKIE=$cookie"

    fun sessionCookie() = if (cookie.isEmpty()) "" else "$COOKIE=$cookie; Secure; Path=/codex-agent"

    fun clear() {
        cookie = ""
        prefs.edit().remove("encrypted").apply()
    }

    private fun open(path: String, method: String, data: JSONObject?): javax.net.ssl.HttpsURLConnection {
        val conn = URL(BASE + path).openConnection() as javax.net.ssl.HttpsURLConnection
        conn.instanceFollowRedirects = false
        conn.connectTimeout = 12000
        conn.readTimeout = if (path.startsWith("/api/server-health")) 65000 else 25000
        // Every header must be set before the body is written (that opens the connection).
        conn.setRequestProperty("Accept", if (path.startsWith("/api/local-files") || path.startsWith("/api/images")) "*/*" else "application/json")
        if (path.startsWith("/api/") && cookie.isNotEmpty()) conn.setRequestProperty("Cookie", "$COOKIE=$cookie")
        if (method != "GET") {
            conn.requestMethod = method
            conn.setRequestProperty("Origin", ORIGIN)
        }
        if (data != null) {
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.doOutput = true
            conn.outputStream.use { it.write(data.toString().toByteArray(Charsets.UTF_8)) }
        }
        return conn
    }

    fun call(path: String, data: JSONObject? = null, method: String = if (data != null) "POST" else "GET"): JSONObject {
        val conn = open(path, method, data)
        try {
            val status = conn.responseCode
            val raw = (if (status in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val json = runCatching { JSONObject(raw) }.getOrNull()
            if (status == 401 && !path.startsWith("/api/auth/")) {
                clear()
                throw SessionExpired()
            }
            if (status !in 200..299) error(json?.str("error")?.ifBlank { null } ?: "Servidor respondeu HTTP $status.")
            if (path == "/api/auth/login/verify") {
                val value = conn.headerFields.entries.filter { it.key.equals("Set-Cookie", true) }
                    .flatMap { it.value }.map { it.substringBefore(';') }
                    .firstOrNull { it.startsWith("$COOKIE=") }?.substringAfter('=') ?: error("O servidor não enviou a sessão.")
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, key())
                val encrypted = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
                prefs.edit().putString("encrypted", Base64.encodeToString(encrypted, Base64.NO_WRAP)).apply()
                cookie = value
            }
            return json ?: error("Resposta inesperada do servidor.")
        } finally { conn.disconnect() }
    }

    /** Raw bytes (images from /api/local-files, /api/images). Limited to 8 MB like the server. */
    fun bytes(path: String): ByteArray {
        val conn = open(path, "GET", null)
        try {
            val status = conn.responseCode
            if (status == 401) { clear(); throw SessionExpired() }
            if (status !in 200..299) error("HTTP $status")
            val length = conn.contentLengthLong
            if (length > 8L * 1024 * 1024) error("Imagem grande demais.")
            return conn.inputStream.use { it.readBytes() }
        } finally { conn.disconnect() }
    }
}
