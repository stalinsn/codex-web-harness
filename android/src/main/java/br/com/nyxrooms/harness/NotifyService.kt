package br.com.nyxrooms.harness

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import org.json.JSONObject
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Background notifications without Firebase: keeps one Server-Sent Events connection to the
 * Harness (/api/events, the same stream the web uses; the server sends a heartbeat every 20 s)
 * and posts a notification when an answer finishes, an approval is waiting or a continuous
 * task ends. Runs as a foreground service with a quiet ongoing notification, only while the
 * user keeps "Notificações" on.
 */
class NotifyService : Service() {
    companion object {
        private const val STATUS_CHANNEL = "status"
        private const val EVENTS_CHANNEL = "events"
        private const val ONGOING_ID = 1
        @Volatile var visibleThread = ""   // conversation on screen right now (no notification for it)
        @Volatile var appVisible = false

        fun enabled(context: Context) = context.getSharedPreferences("app", Context.MODE_PRIVATE).getBoolean("notifications", false)
        fun start(context: Context) {
            val intent = Intent(context, NotifyService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
        fun stop(context: Context) { context.stopService(Intent(context, NotifyService::class.java)) }
    }

    @Volatile private var running = false
    private var worker: Thread? = null
    private val startedAt = System.currentTimeMillis()
    private val taskStatus = mutableMapOf<String, String>()
    private var nextId = 100

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        channels()
        val ongoing = notification(STATUS_CHANNEL, "Codex Harness conectado", "Avisa quando respostas e execuções terminarem.", null, ongoing = true)
        if (Build.VERSION.SDK_INT >= 34) startForeground(ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        else startForeground(ONGOING_ID, ongoing)
        if (!running) {
            running = true
            worker = Thread({ loop() }, "harness-events").apply { isDaemon = true; start() }
        }
        return START_STICKY
    }

    override fun onDestroy() { running = false; worker?.interrupt(); super.onDestroy() }

    private fun channels() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(STATUS_CHANNEL, "Conexão em segundo plano", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
        manager.createNotificationChannel(NotificationChannel(EVENTS_CHANNEL, "Respostas e execuções", NotificationManager.IMPORTANCE_HIGH))
    }

    private fun notification(channel: String, title: String, text: String, threadId: String?, ongoing: Boolean = false): Notification {
        val open = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (!threadId.isNullOrEmpty()) open.putExtra("openThread", threadId)
        val pending = PendingIntent.getActivity(this, (threadId ?: "").hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, channel) else Notification.Builder(this)
        return builder.setSmallIcon(R.drawable.ic_chat).setContentTitle(title).setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text)).setContentIntent(pending)
            .setOngoing(ongoing).setAutoCancel(!ongoing).setColor(C.LAV).build()
    }

    private fun post(title: String, text: String, threadId: String?) {
        runCatching { getSystemService(NotificationManager::class.java).notify(nextId++, notification(EVENTS_CHANNEL, title, text, threadId)) }
    }

    private fun titleOf(threadId: String): String {
        val titles = runCatching { JSONObject(getSharedPreferences("app", MODE_PRIVATE).getString("titles", "{}") ?: "{}") }.getOrNull()
        return titles?.optString(threadId).orEmpty().ifBlank { "Conversa" }
    }

    private fun loop() {
        val api = HarnessApi(this)
        var lastId = ""
        var backoff = 3000L
        while (running) {
            val cookie = api.cookieHeader()
            if (cookie.isEmpty()) { post("Notificações pausadas", "Entre de novo no app para voltar a receber avisos.", null); stopSelf(); return }
            try {
                val conn = URL("$BASE/api/events").openConnection() as javax.net.ssl.HttpsURLConnection
                conn.connectTimeout = 15000
                conn.readTimeout = 70000 // heartbeat every 20 s
                conn.setRequestProperty("Accept", "text/event-stream")
                conn.setRequestProperty("Cookie", cookie)
                if (lastId.isNotEmpty()) conn.setRequestProperty("Last-Event-ID", lastId)
                if (conn.responseCode == 401) { api.clear(); post("Notificações pausadas", "Sua sessão expirou. Entre de novo no app.", null); stopSelf(); return }
                if (conn.responseCode !in 200..299) error("HTTP ${conn.responseCode}")
                backoff = 3000L
                conn.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                    val data = StringBuilder()
                    while (running) {
                        val line = reader.readLine() ?: break
                        when {
                            line.startsWith("data:") -> data.append(line.removePrefix("data:").trim())
                            line.isEmpty() && data.isNotEmpty() -> {
                                runCatching { JSONObject(data.toString()) }.getOrNull()?.let { event -> lastId = event.optString("id"); handle(event) }
                                data.setLength(0)
                            }
                        }
                    }
                }
                conn.disconnect()
            } catch (_: InterruptedException) { return
            } catch (_: Exception) { /* network change, server restart: reconnect below */ }
            if (!running) return
            try { Thread.sleep(backoff) } catch (_: InterruptedException) { return }
            backoff = (backoff * 2).coerceAtMost(60_000L)
        }
    }

    private fun handle(event: JSONObject) {
        // The server replays up to 500 recent events on connect; only react to new ones.
        if (eventTime(event.optString("at")) < startedAt - 5000) {
            if (event.optString("type") == "task-updated") event.optJSONObject("data")?.let { taskStatus[it.optString("id")] = it.optString("status") }
            return
        }
        val data = event.optJSONObject("data") ?: return
        when (event.optString("type")) {
            "turn-completed" -> {
                val threadId = data.optString("threadId")
                if (appVisible && visibleThread == threadId) return
                val status = data.optJSONObject("turn")?.optString("status").orEmpty()
                val title = titleOf(threadId)
                when (status) {
                    "completed" -> post("Resposta pronta", title, threadId)
                    "failed" -> post("A resposta falhou", title, threadId)
                    "interrupted" -> post("Resposta interrompida", title, threadId)
                }
            }
            "server-request" -> {
                val threadId = data.optJSONObject("params")?.optString("threadId").orEmpty()
                if (appVisible && visibleThread == threadId) return
                post("Aprovação pendente", "${titleOf(threadId)} · o agente aguarda sua decisão.", threadId)
            }
            "task-updated" -> {
                val id = data.optString("id"); val status = data.optString("status")
                val previous = taskStatus.put(id, status)
                if (previous == status) return
                val title = data.optString("title").ifBlank { "Execução contínua" }
                val threadId = data.optString("threadId")
                when (status) {
                    "completed" -> post("Execução concluída", title, threadId)
                    "failed", "blocked" -> post("Execução falhou", "$title · ${data.optString("error").take(120)}", threadId)
                }
            }
        }
    }

    private fun eventTime(at: String): Long = runCatching {
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(at.take(19))!!.time
    }.getOrDefault(0L)
}

/** Restarts notifications after the phone reboots or the app is updated, if the user enabled them. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action in setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED) && NotifyService.enabled(context)) {
            runCatching { NotifyService.start(context) }
        }
    }
}
