package br.com.nyxrooms.harness

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.net.URL
import java.security.MessageDigest

/**
 * In-app update: downloads the APK named in android-release.json, checks its SHA-256 and
 * hands it to the system PackageInstaller. Android always asks the user to confirm the
 * install (one tap); no browser or Downloads folder involved.
 */
class Updater(private val activity: Activity, private val onStatus: (String) -> Unit) {
    private val action = "${activity.packageName}.INSTALL_RESULT"
    private var receiver: BroadcastReceiver? = null

    fun canInstall() = Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls()

    fun openInstallPermission() {
        activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
    }

    /** Runs on a worker thread. */
    fun downloadAndInstall(release: JSONObject, progress: (Int) -> Unit) {
        val name = release.str("name")
        require(Regex("^[A-Za-z0-9._-]+\\.apk$").matches(name)) { "Nome de APK inválido no manifesto." }
        val expected = release.str("sha256").lowercase()
        require(Regex("^[0-9a-f]{64}$").matches(expected)) { "O manifesto não traz o SHA-256 do APK." }
        val conn = URL("$BASE/$name").openConnection() as javax.net.ssl.HttpsURLConnection
        val digest = MessageDigest.getInstance("SHA-256")
        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(activity.packageName) }
        val sessionId = installer.createSession(params)
        val session = installer.openSession(sessionId)
        try {
            conn.connectTimeout = 15000; conn.readTimeout = 30000
            if (conn.responseCode !in 200..299) error("Download falhou (HTTP ${conn.responseCode}).")
            val total = conn.contentLengthLong
            session.openWrite("base.apk", 0, total.takeIf { it > 0 } ?: -1).use { out ->
                conn.inputStream.use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var read: Int
                    var done = 0L
                    while (input.read(buffer).also { read = it } >= 0) {
                        out.write(buffer, 0, read); digest.update(buffer, 0, read); done += read
                        if (total > 0) progress((done * 100 / total).toInt())
                    }
                    session.fsync(out)
                }
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (actual != expected) error("O APK baixado não confere com o manifesto (SHA-256). Nada foi instalado.")
            listen()
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val pending = PendingIntent.getBroadcast(activity, sessionId, Intent(action).setPackage(activity.packageName), flags)
            session.commit(pending.intentSender)
        } catch (error: Throwable) {
            session.abandon(); throw error
        } finally {
            session.close(); conn.disconnect()
        }
    }

    private fun listen() {
        if (receiver != null) return
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                    PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                        @Suppress("DEPRECATION")
                        val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                        confirm?.let { activity.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    }
                    PackageInstaller.STATUS_SUCCESS -> onStatus("Atualização instalada.")
                    PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                        onStatus("O Android recusou: esta versão foi assinada com outra chave. Desinstale o app uma vez e instale pela página de download.")
                    PackageInstaller.STATUS_FAILURE_ABORTED -> onStatus("Instalação cancelada.")
                    else -> onStatus(intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "A instalação falhou.")
                }
            }
        }
        val filter = IntentFilter(action)
        if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else @Suppress("UnspecifiedRegisterReceiverFlag") activity.registerReceiver(receiver, filter)
    }

    fun release() { receiver?.let { runCatching { activity.unregisterReceiver(it) } }; receiver = null }
}
