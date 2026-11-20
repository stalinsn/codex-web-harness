package br.com.nyxrooms.harness

import android.app.*
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.*
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.util.LruCache
import android.view.*
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.Executors

private const val TAB_CHAT = 0
private const val TAB_PROJECTS = 1
private const val TAB_TASKS = 2
private const val TAB_OVERVIEW = 3
private val TOOL_TYPES = setOf("commandExecution", "fileChange", "webSearch", "mcpToolCall", "collabToolCall", "subAgentActivity", "plan", "reasoning")

private const val PICK_IMAGES = 41
private const val PICK_FILES = 42
private const val ASK_MIC = 43
private const val ASK_NOTIFY = 44
private const val DICTATE_PHONE = 44

private data class Attachment(val name: String, val mime: String, val data: String, val image: Boolean, val size: Long)

class MainActivity : Activity() {
    private val worker = Executors.newFixedThreadPool(3)
    private val clock = Handler(Looper.getMainLooper())
    private val images = object : LruCache<String, Bitmap>(24 * 1024 * 1024) { override fun sizeOf(key: String, value: Bitmap) = value.byteCount }
    private lateinit var ui: Kit
    private lateinit var md: Markdown
    private lateinit var api: HarnessApi
    private val prefs by lazy { getSharedPreferences("app", MODE_PRIVATE) }

    private var epoch = 0
    private var tab = -1
    private lateinit var content: FrameLayout
    private lateinit var tabBar: LinearLayout
    private var failedTasks = 0

    // Conversation state
    private var threadId = ""
    private var threadTitle = ""
    private var threadCwd = ""
    private var newCwd = ""
    private var newDraftId = java.util.UUID.randomUUID().toString()
    private var dictationThread = ""
    private var dictationDraft = ""
    private var accountId = "codex"
    private var model = ""
    private var effort = ""
    private var next = ""
    private var older = listOf<JSONObject>()
    private var latest = listOf<JSONObject>()
    private var queue = listOf<JSONObject>()
    private var rendered = ""
    private var historyPending = false
    private var pollCount = 0
    private val expanded = mutableSetOf<String>()
    private val collapsed = mutableSetOf<String>()
    private var accounts = listOf<JSONObject>()
    private var projects = listOf<JSONObject>()
    private var rotation = JSONObject()
    private lateinit var history: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var composer: EditText
    private lateinit var liveText: TextView
    private lateinit var liveDot: View
    private lateinit var stopButton: TextView
    private lateinit var queueBox: LinearLayout
    private lateinit var approvalBox: LinearLayout
    private lateinit var contextBox: LinearLayout
    private var contextSnapshot: JSONObject? = null
    private var accessMode = ""
    private var contextPending = false
    private var approvalsPending = false
    private lateinit var settingsChip: TextView
    private lateinit var steerButton: TextView
    private lateinit var composerHint: TextView
    private lateinit var composerRow: LinearLayout
    private lateinit var recordingBar: LinearLayout
    private lateinit var recordingLevel: TextView
    private lateinit var recordingTime: TextView
    private lateinit var attachmentStrip: LinearLayout
    private val attachments = mutableListOf<Attachment>()
    private var transcribingThread: String? = null
    private var sendingMessage = false
    private val voice by lazy { VoiceRecorder(this) }
    private val updater by lazy { Updater(this) { runOnUiThread { ui.toast(it) } } }
    private val meter = object : Runnable {
        override fun run() {
            if (!voice.recording || !::recordingLevel.isInitialized) return
            val level = voice.level()
            val bars = (1..24).joinToString("") { i -> if (i <= (level * 24 * 1.6f).toInt().coerceAtLeast(1)) "▮" else "▯" }
            recordingLevel.text = bars
            val elapsed = System.currentTimeMillis() - voice.startedAt
            recordingTime.text = "%d:%02d".format(elapsed / 60000, (elapsed / 1000) % 60)
            if (elapsed >= 180_000) finishRecording(send = prefs.getBoolean("voiceAutoSend", false)) else clock.postDelayed(this, 120)
        }
    }

    // Lists
    private var archived = false
    private var query = ""
    private var taskFilter = 0

    private val poll = object : Runnable {
        override fun run() {
            when (tab) {
                TAB_CHAT -> if (threadId.isNotEmpty()) { readHistory(silent = true); pollCount++; if (isLocal() || running() || queue.isNotEmpty() || pollCount % 4 == 0) readQueue(); if (pollCount % 4 == 0) readContext(); if (!isLocal() && running() && pollCount % 2 == 0) readApprovals() }
                TAB_TASKS -> if (pollCount++ % 3 == 0) tasksTab(refreshOnly = true)
            }
            clock.postDelayed(this, 2500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = C.BG
        window.navigationBarColor = C.BG
        ui = Kit(this)
        api = HarnessApi(this)
        md = Markdown(ui, ::openLink, ::loadImage, ::showImage, ::showPreview)
        accountId = prefs.getString("accountId", "codex") ?: "codex"
        model = prefs.getString("model", "") ?: ""
        effort = prefs.getString("effort", "") ?: ""
        threadId = prefs.getString("threadId", "") ?: ""
        threadTitle = prefs.getString("threadTitle", "") ?: ""
        setContentView(ui.column().apply {
            setBackgroundColor(C.BG); gravity = Gravity.CENTER
            addView(ui.text("Conectando ao Nyxrooms…", 15f, C.TX2))
        })
        request({ api.call("/api/auth/status") }, onError = { login(it) }) {
            if (it.optBoolean("authenticated")) {
                val deep = intent?.getStringExtra("openThread").orEmpty()
                if (deep.isNotEmpty()) { threadId = deep; threadTitle = titleCache(deep); intent?.removeExtra("openThread") }
                shell(if (threadId.isNotEmpty()) TAB_CHAT else TAB_PROJECTS)
                if (NotifyService.enabled(this)) runCatching { NotifyService.start(this) }
            } else login()
        }
    }

    override fun onStart() {
        super.onStart()
        clock.post(poll)
        if (!updateChecked) { updateChecked = true; checkUpdate(manual = false) }
    }
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        val active = tab == TAB_CHAT && ::scroll.isInitialized && ::history.isInitialized
        val oldY = if (active) scroll.scrollY else 0
        val wasBottom = active && history.height - (oldY + scroll.height) < dp(120)
        val anchor = if (active) (0 until history.childCount).map { history.getChildAt(it) }.lastOrNull { it.top <= oldY } else null
        val offset = if (anchor != null) oldY - anchor.top else 0
        super.onConfigurationChanged(newConfig)
        if (active) scroll.viewTreeObserver.addOnGlobalLayoutListener(object : android.view.ViewTreeObserver.OnGlobalLayoutListener {
            override fun onGlobalLayout() {
                if (scroll.viewTreeObserver.isAlive) scroll.viewTreeObserver.removeOnGlobalLayoutListener(this)
                if (wasBottom) scroll.fullScroll(View.FOCUS_DOWN) else scroll.scrollTo(0, (anchor?.top ?: oldY) + offset)
            }
        })
    }
    override fun onStop() { clock.removeCallbacks(poll); super.onStop() }
    override fun onDestroy() { voice.stopQuietly(); updater.release(); worker.shutdownNow(); super.onDestroy() }
    override fun onPause() {
        NotifyService.appVisible = false
        if (voice.recording) finishRecording(send = false)
        super.onPause()
    }

    @Deprecated("Android back callback")
    override fun onBackPressed() {
        if (tab == TAB_PROJECTS || tab < 0) super.onBackPressed() else show(TAB_PROJECTS)
    }

    private fun <T> request(work: () -> T, onError: (String) -> Unit = { ui.toast(it) }, scoped: Boolean = true, done: (T) -> Unit) {
        val token = epoch
        worker.execute {
            val result = runCatching(work)
            runOnUiThread {
                if ((scoped && token != epoch) || isFinishing || isDestroyed) return@runOnUiThread
                result.fold(done) { error ->
                    if (error is SessionExpired) login(error.message.orEmpty())
                    else onError(error.message ?: "Falha de conexão.")
                }
            }
        }
    }

    private fun dp(n: Int) = ui.dp(n)
    private fun draftKey(id: String = threadId) = if (id.isEmpty()) "draft:new:$newDraftId" else "draft:$id"
    private fun isLocal() = threadId.startsWith("ext-")
    private fun allTurns() = (older + latest).distinctBy { it.str("id") }
    private fun running() = allTurns().lastOrNull()?.str("status") == "inProgress"
    private fun account(id: String = accountId) = accounts.firstOrNull { it.str("id") == id }
    private fun timestamp(seconds: Double, pattern: String): String = SimpleDateFormat(pattern, Locale("pt", "BR")).apply {
        timeZone = TimeZone.getTimeZone("America/Sao_Paulo")
    }.format(Date((seconds * 1000).toLong()))
    private fun clockTime(seconds: Double) = timestamp(seconds, "HH:mm")
    private fun messageTime(seconds: Double) = timestamp(seconds, "dd/MM/yyyy · HH:mm")
    private fun duration(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return when { s < 60 -> "$s s"; s < 3600 -> "${s / 60} min ${s % 60} s"; else -> "${s / 3600} h ${(s % 3600) / 60} min" }
    }
    private fun ago(ms: Long): String {
        val s = ((System.currentTimeMillis() - ms) / 1000).coerceAtLeast(0)
        return when { s < 60 -> "agora"; s < 3600 -> "há ${s / 60} min"; s < 86400 -> "há ${s / 3600} h"; else -> "há ${s / 86400} d" }
    }
    private fun saveSelection() = prefs.edit().putString("accountId", accountId).putString("model", model).putString("effort", effort).apply()
    private fun saveThread() {
        prefs.edit().putString("threadId", threadId).putString("threadTitle", threadTitle).apply()
        if (threadId.isNotEmpty() && threadTitle.isNotBlank()) rememberTitles(mapOf(threadId to threadTitle))
        NotifyService.visibleThread = if (tab == TAB_CHAT) threadId else ""
    }
    private fun titleCache(id: String) = runCatching { JSONObject(prefs.getString("titles", "{}") ?: "{}").optString(id) }.getOrDefault("").ifBlank { "Conversa" }
    private fun rememberTitles(titles: Map<String, String>) {
        val stored = runCatching { JSONObject(prefs.getString("titles", "{}") ?: "{}") }.getOrDefault(JSONObject())
        titles.forEach { (k, v) -> stored.put(k, v.take(90)) }
        val keys = stored.keys().asSequence().toList()
        if (keys.size > 400) keys.take(keys.size - 400).forEach { stored.remove(it) }
        prefs.edit().putString("titles", stored.toString()).apply()
    }

    override fun onResume() { super.onResume(); NotifyService.appVisible = true; NotifyService.visibleThread = if (tab == TAB_CHAT) threadId else "" }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val deep = intent.getStringExtra("openThread").orEmpty()
        if (deep.isNotEmpty() && tab >= 0) openThread(deep, titleCache(deep))
    }
    private fun loadAccounts(done: () -> Unit = {}) = request({ api.call("/api/accounts") }, onError = {}) {
        accounts = it.optJSONArray("accounts").objects(); rotation = it.optJSONObject("rotation") ?: JSONObject(); loadDefaultModels(); done()
    }

    // Model actually in use: explicit choice › account setting › model the provider reported in this
    // conversation › default flagged by the account's catalog. Never just "padrão" when it can be known.
    private val defaultModels = mutableMapOf<String, String>()
    private val defaultEfforts = mutableMapOf<String, String>()
    private fun loadDefaultModels() {
        for (acc in accounts.filter { it.optBoolean("enabled") && it.str("model").isBlank() && defaultModels[it.str("id")].isNullOrEmpty() }) {
            val id = acc.str("id")
            if (id in defaultModels) continue // request in flight; a failure clears the marker so the next refresh retries
            defaultModels[id] = ""
            worker.execute {
                val def = runCatching { api.call("/api/accounts/${enc(id)}/models").optJSONArray("models").objects().firstOrNull { it.optBoolean("isDefault") } }.getOrNull()
                val found = def?.let { it.str("label").ifBlank { it.str("id") } }.orEmpty()
                runOnUiThread {
                    if (found.isNotEmpty()) { defaultModels[id] = found; def?.str("defaultEffort")?.let { defaultEfforts[id] = it }; updateLive() } else defaultModels.remove(id)
                }
            }
        }
    }
    private fun prettyModel(id: String): String {
        Regex("^claude-(opus|sonnet|haiku|fable)-(\\d+)(?:-(\\d+))?", RegexOption.IGNORE_CASE).find(id)?.let { m ->
            return m.groupValues[1].replaceFirstChar { it.uppercase() } + " " + m.groupValues[2] + (if (m.groupValues[3].isNotEmpty()) ".${m.groupValues[3]}" else "")
        }
        return mapOf("opus" to "Opus", "sonnet" to "Sonnet", "haiku" to "Haiku", "fable" to "Fable", "best" to "Best")[id.lowercase()] ?: id
    }
    private fun resolvedModelFor(id: String): String {
        val acc = account(id)
        val configured = acc?.str("model").orEmpty()
        if (configured.isNotEmpty()) return prettyModel(configured)
        return reportedModel(id).ifEmpty { defaultModels[id].orEmpty() }.let { if (it.isNotEmpty()) prettyModel(it) else "CLI" }
    }
    private fun reportedModel(accountId: String) = allTurns().lastOrNull { it.optJSONObject("account")?.str("id") == accountId && it.str("model").isNotBlank() }?.str("model").orEmpty()
    /** Pair(model name, true when it is the account default rather than a choice). */
    private fun resolvedModel(acc: JSONObject?): Pair<String, Boolean> {
        if (model.isNotEmpty()) return prettyModel(model) to false
        val configured = acc?.str("model").orEmpty()
        if (configured.isNotEmpty()) return prettyModel(configured) to false
        val id = acc?.str("id") ?: accountId
        val reported = reportedModel(id).ifEmpty { defaultModels[id].orEmpty() }
        return (if (reported.isNotEmpty()) prettyModel(reported) else "padrão da CLI") to true
    }

    // ───────────────────────── Login ─────────────────────────

    private fun login(message: String = "", challenge: String = "", hint: String = "") {
        epoch++; tab = -1
        val form = ui.column().apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(26), dp(24), dp(26), dp(24)) }
        setContentView(ScrollView(this).apply { isFillViewport = true; setBackgroundColor(C.BG); addView(form) })
        form.addView(ImageView(this).apply { setImageResource(R.mipmap.ic_launcher); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }, ui.lp(dp(64), dp(64)))
        form.addView(ui.text("Codex Harness", 30f, bold = true), ui.lp(top = 16, bottom = 8))
        form.addView(ui.text(if (challenge.isEmpty()) "Entre com sua senha do Web Harness." else "Digite o código enviado para $hint.", 16f, C.TX2), ui.lp(bottom = 24))
        val input = ui.field(if (challenge.isEmpty()) "Digite sua senha" else "Código do e-mail").apply {
            id = View.generateViewId()
            inputType = if (challenge.isEmpty()) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_CLASS_NUMBER
        }
        form.addView(ui.text(if (challenge.isEmpty()) "Senha" else "Código de verificação", 14f, bold = true).apply { labelFor = input.id }, ui.lp(bottom = 8))
        if (challenge.isEmpty()) {
            val passwordRow = ui.row().apply { background = ui.shape(C.PANEL, 13, 1, C.LINE) }
            input.background = null
            input.transformationMethod = PasswordTransformationMethod.getInstance()
            passwordRow.addView(input, ui.lp(0, dp(56), 1f))
            val eye = ImageButton(this).apply { background = null; setColorFilter(C.TX) }
            fun updateEye(visible: Boolean) {
                eye.setImageResource(if (visible) R.drawable.ic_eye_off else R.drawable.ic_eye)
                eye.contentDescription = if (visible) "Ocultar senha" else "Mostrar senha"
            }
            updateEye(false)
            eye.setOnClickListener {
                val visible = input.transformationMethod != null
                val selection = input.selectionEnd
                input.transformationMethod = if (visible) null else PasswordTransformationMethod.getInstance()
                if (selection >= 0) input.setSelection(selection)
                updateEye(visible)
            }
            passwordRow.addView(eye, ui.lp(dp(56), dp(56)))
            form.addView(passwordRow)
        } else form.addView(input, ui.lp(MATCH, dp(56)))
        val status = ui.text(message, 14f, C.TX2)
        lateinit var go: TextView
        go = ui.action(if (challenge.isEmpty()) "Enviar código" else "Entrar", primary = true) {
            val value = input.text.toString()
            if (value.isBlank() || !go.isEnabled) return@action
            go.isEnabled = false; status.text = "Conectando…"
            request({
                if (challenge.isEmpty()) api.call("/api/auth/login/start", obj("password" to value))
                else api.call("/api/auth/login/verify", obj("challengeId" to challenge, "code" to value.trim()))
            }, onError = { status.text = it; go.isEnabled = true }) {
                input.text.clear()
                if (challenge.isEmpty()) login(challenge = it.getString("challengeId"), hint = it.str("emailHint")) else shell(TAB_PROJECTS)
            }
        }
        form.addView(go, ui.lp(MATCH, dp(52), top = 16))
        if (challenge.isNotEmpty()) form.addView(ui.action("Voltar para a senha") { login() }, ui.lp(MATCH, dp(46), top = 10))
        form.addView(status, ui.lp(top = 12))
        input.imeOptions = EditorInfo.IME_ACTION_DONE
        input.setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_DONE) { go.performClick(); true } else false }
    }

    // ───────────────────────── Shell and tabs ─────────────────────────

    private fun shell(start: Int) {
        val root = ui.column().apply { setBackgroundColor(C.BG) }
        content = FrameLayout(this)
        root.addView(content, ui.lp(MATCH, 0, 1f))
        root.addView(View(this).apply { setBackgroundColor(0xff1c2027.toInt()) }, ui.lp(MATCH, 1))
        tabBar = ui.row().apply { setPadding(dp(6), dp(6), dp(6), dp(8)); setBackgroundColor(C.BG) }
        root.addView(tabBar, ui.lp())
        setContentView(root)
        loadAccounts()
        show(start)
    }

    private fun drawTabs() {
        tabBar.removeAllViews()
        listOf(Triple("Conversa", R.drawable.ic_chat, TAB_CHAT), Triple("Projetos", R.drawable.ic_folder, TAB_PROJECTS),
            Triple("Execuções", R.drawable.ic_bolt, TAB_TASKS), Triple("Visão geral", R.drawable.ic_gauge, TAB_OVERVIEW)).forEach { (label, icon, id) ->
            val on = id == tab
            val item = ui.column().apply { gravity = Gravity.CENTER_HORIZONTAL; setOnClickListener { show(id) }; contentDescription = label }
            val frame = FrameLayout(this)
            frame.addView(ImageView(this).apply {
                setImageResource(icon); setColorFilter(if (on) C.LAV else C.TX3)
                background = if (on) ui.shape(0xff23283a.toInt(), 14) else null
                setPadding(dp(12), dp(4), dp(12), dp(4))
            }, FrameLayout.LayoutParams(dp(52), dp(30), Gravity.CENTER))
            if (id == TAB_TASKS && failedTasks > 0) frame.addView(ui.text("$failedTasks", 9.5f, Color.WHITE, bold = true).apply {
                gravity = Gravity.CENTER; background = ui.shape(C.RED, 9); setPadding(dp(4), 0, dp(4), 0); minWidth = dp(16)
            }, FrameLayout.LayoutParams(WRAP, dp(16), Gravity.TOP or Gravity.END))
            item.addView(frame, ui.lp(dp(60), dp(32)))
            item.addView(ui.text(label, 10.5f, if (on) C.TX else C.TX3), ui.lp(WRAP, WRAP, top = 3))
            tabBar.addView(item, ui.lp(0, WRAP, 1f))
        }
    }

    private fun show(target: Int) {
        epoch++; tab = target; historyPending = false; pollCount = 0
        NotifyService.visibleThread = if (target == TAB_CHAT) threadId else ""
        content.removeAllViews()
        drawTabs()
        when (target) {
            TAB_CHAT -> chatTab()
            TAB_PROJECTS -> projectsTab()
            TAB_TASKS -> tasksTab()
            TAB_OVERVIEW -> overviewTab()
        }
    }

    private fun header(kicker: String, title: String, vararg actions: View): LinearLayout {
        val bar = ui.row().apply { setPadding(dp(16), dp(14), dp(12), dp(10)) }
        val titles = ui.column()
        if (kicker.isNotEmpty()) titles.addView(ui.caption(kicker))
        titles.addView(ui.text(title, 21f, bold = true).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }, ui.lp(top = 2))
        bar.addView(titles, ui.lp(0, WRAP, 1f))
        actions.forEach { bar.addView(it, ui.lp(dp(40), dp(40), start = 6)) }
        return bar
    }

    private fun page(): LinearLayout = ui.column().also { content.addView(it, FrameLayout.LayoutParams(MATCH, MATCH)) }

    // ───────────────────────── Conversation tab ─────────────────────────

    /** True while the reader is at the end: new content, images and the keyboard keep it pinned there. */
    private var followLatest = true
    private var unseenNew = false
    private lateinit var jumpButton: TextView
    private fun scrollToLatest(smooth: Boolean = false) {
        if (!::scroll.isInitialized) return
        followLatest = true; unseenNew = false; updateJump()
        scroll.post { val y = (history.height - scroll.height).coerceAtLeast(0); if (smooth) scroll.smoothScrollTo(0, y) else scroll.scrollTo(0, y) }
    }
    private fun updateJump() {
        if (!::jumpButton.isInitialized) return
        val far = ::scroll.isInitialized && history.height - (scroll.scrollY + scroll.height) > dp(160)
        jumpButton.visibility = if (far || unseenNew && !followLatest) View.VISIBLE else View.GONE
        jumpButton.text = if (unseenNew && !followLatest) "↓  Novas mensagens" else "↓"
        jumpButton.layoutParams = (jumpButton.layoutParams as FrameLayout.LayoutParams).apply { width = if (unseenNew && !followLatest) WRAP else dp(44) }
        jumpButton.setPadding(if (unseenNew && !followLatest) dp(16) else 0, 0, if (unseenNew && !followLatest) dp(16) else 0, 0)
    }

    private fun openThread(id: String, title: String, cwd: String = "", accountHint: String = "") {
        followLatest = true; unseenNew = false
        threadId = id; threadTitle = title; threadCwd = cwd
        older = emptyList(); latest = emptyList(); queue = emptyList(); next = ""; rendered = ""; contextSnapshot = null; accessMode = ""; expanded.clear(); collapsed.clear()
        if (accountHint.isNotEmpty() && account(accountHint) != null) accountId = accountHint
        saveThread()
        show(TAB_CHAT)
    }

    private fun chatTab() {
        rendered = ""
        val root = page()
        if (threadId.isEmpty() && newCwd.isEmpty() && threadTitle != "Nova conversa") { chatEmpty(root); return }
        val bar = ui.row().apply { setPadding(dp(12), dp(10), dp(12), dp(10)) }
        bar.addView(ui.iconButton(R.drawable.ic_back, "Projetos") { show(TAB_PROJECTS) })
        val titles = ui.column().apply { setPadding(dp(10), 0, dp(6), 0) }
        val projectName = projectFor(threadCwd.ifEmpty { newCwd })
        titles.addView(ui.text("Codex › ${projectName.ifEmpty { "Sem projeto" }}", 11f, C.TX3).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END })
        titles.addView(ui.text(threadTitle.ifBlank { "Nova conversa" }, 15.5f, bold = true).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }, ui.lp(top = 1))
        bar.addView(titles, ui.lp(0, WRAP, 1f))
        bar.addView(ui.iconButton(R.drawable.ic_more, "Opções da conversa") { threadMenu() })
        root.addView(bar)
        root.addView(View(this).apply { setBackgroundColor(0xff1c2027.toInt()) }, ui.lp(MATCH, 1))

        // Live strip: who answers, with which model, and what it is doing now.
        val live = ui.row().apply { background = ui.shape(0xff161a24.toInt(), 14, 1, 0xff262c3b.toInt()); setPadding(dp(12), dp(8), dp(8), dp(8)) }
        liveDot = ui.dot(C.TX3)
        live.addView(liveDot)
        liveText = ui.text("", 12.5f, C.TX2).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        live.addView(liveText, ui.lp(0, WRAP, 1f, start = 8))
        stopButton = ui.text("■ Parar", 12f, 0xffffb4b4.toInt(), bold = true).apply {
            background = ui.shape(0xff2c1717.toInt(), 10, 1, 0xff6b2a2a.toInt()); setPadding(dp(10), dp(5), dp(10), dp(5)); visibility = View.GONE
            setOnClickListener { interrupt() }
        }
        live.addView(stopButton)
        root.addView(live, ui.lp(start = 12, end = 12, top = 10))
        contextBox = ui.column()
        root.addView(contextBox, ui.lp(start = 12, end = 12, top = 6))
        drawContext()

        history = ui.column().apply { setPadding(dp(14), dp(10), dp(14), dp(16)) }
        scroll = ScrollView(this).apply { isFillViewport = true; addView(history) }
        val historyFrame = FrameLayout(this)
        historyFrame.addView(scroll, FrameLayout.LayoutParams(MATCH, MATCH))
        jumpButton = ui.text("↓", 18f, C.TX, bold = true).apply {
            gravity = Gravity.CENTER; contentDescription = "Ir para as mensagens mais recentes"
            background = ui.shape(C.CARD2, 22, 1, C.LINE2); visibility = View.GONE; elevation = dp(4).toFloat()
            setOnClickListener { scrollToLatest(smooth = true) }
        }
        historyFrame.addView(jumpButton, FrameLayout.LayoutParams(dp(44), dp(44), Gravity.END or Gravity.BOTTOM).apply { setMargins(0, 0, dp(16), dp(12)) })
        var touching = false
        scroll.setOnTouchListener { _, e -> touching = e.actionMasked == MotionEvent.ACTION_DOWN || e.actionMasked == MotionEvent.ACTION_MOVE; false }
        scroll.setOnScrollChangeListener { _, _, y, _, _ ->
            val nearEnd = history.height - (y + scroll.height) < dp(120)
            if (nearEnd) { followLatest = true; unseenNew = false } else if (touching) followLatest = false
            updateJump()
        }
        // Late layout changes (images loading, cards expanding, keyboard opening) keep the end in view.
        val keepEnd = View.OnLayoutChangeListener { _, _, top, _, bottom, _, oldTop, _, oldBottom -> if (followLatest && (bottom - top) != (oldBottom - oldTop)) scroll.post { scroll.scrollTo(0, (history.height - scroll.height).coerceAtLeast(0)) } }
        history.addOnLayoutChangeListener(keepEnd)
        scroll.addOnLayoutChangeListener(keepEnd)
        root.addView(historyFrame, ui.lp(MATCH, 0, 1f))

        approvalBox = ui.column()
        root.addView(approvalBox, ui.lp(start = 10, end = 10))
        queueBox = ui.column()
        root.addView(queueBox, ui.lp(start = 10, end = 10))

        // Composer
        val box = ui.column().apply { background = ui.shape(C.PANEL, 22, 1, C.LINE2); setPadding(dp(10), dp(6), dp(10), dp(8)) }
        composerHint = ui.text("", 11f, C.TX3).apply { visibility = View.GONE; setPadding(dp(4), dp(4), 0, 0) }
        box.addView(composerHint)
        composer = PasteAwareEditText(this) { uris -> addAttachmentUris(uris) }.apply {
            hint = "Mensagem para o Codex…"; setHintTextColor(C.TX3); setTextColor(C.TX); textSize = 15f; background = null
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            maxLines = 6; setPadding(dp(4), dp(6), dp(4), dp(6))
            setText(prefs.getString(draftKey(), ""))
        }
        attachmentStrip = ui.row()
        box.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(attachmentStrip) }, ui.lp(bottom = 2))
        box.addView(composer, ui.lp())
        recordingBar = ui.row().apply { visibility = View.GONE; setPadding(dp(2), dp(4), dp(2), dp(4)) }
        recordingBar.addView(ui.action("■ Parar e transcrever", primary = true) { finishRecording(send = prefs.getBoolean("voiceAutoSend", false)) }.apply { contentDescription = "Parar gravação e transcrever" }, ui.lp(WRAP, dp(48), end = 8))
        recordingLevel = ui.text("", 12f, C.LAV).apply { maxLines = 1 }
        recordingBar.addView(recordingLevel, ui.lp(0, WRAP, 1f))
        recordingTime = ui.text("0:00", 12.5f, C.TX2, mono = true)
        recordingBar.addView(recordingTime, ui.lp(WRAP, WRAP, start = 8, end = 8))
        recordingBar.addView(ui.text("✕", 16f, C.TX3).apply { setPadding(dp(8), dp(6), dp(8), dp(6)); contentDescription = "Descartar gravação"; setOnClickListener { voice.stopQuietly(); showRecording(false); ui.toast("Gravação descartada.") } })
        box.addView(recordingBar, ui.lp())
        val tools = ui.row()
        composerRow = tools
        tools.addView(ui.iconButton(R.drawable.ic_plus, "Anexar") { attachMenu() }, ui.lp(dp(38), dp(38), end = 6))
        settingsChip = ui.text("", 12f, C.TX2).apply {
            background = ui.shape(Color.TRANSPARENT, 11, 1, C.LINE); setPadding(dp(10), dp(7), dp(10), dp(7)); maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.ic_tune, 0, 0, 0); compoundDrawablePadding = dp(6)
            compoundDrawablesRelative[0]?.setBounds(0, 0, dp(16), dp(16)); compoundDrawablesRelative[0]?.setTint(C.TX2)
            setCompoundDrawablesRelative(compoundDrawablesRelative[0], null, null, null)
            setOnClickListener { settingsSheet() }
        }
        tools.addView(settingsChip, ui.lp(0, WRAP, 1f, end = 8))
        val steer = ui.text("Orientar", 12.5f, C.TX).apply {
            background = ui.shape(C.CARD2, 12, 1, C.LINE2); setPadding(dp(12), dp(9), dp(12), dp(9)); visibility = View.GONE
            setOnClickListener { steer() }
        }
        steerButton = steer
        tools.addView(steer, ui.lp(WRAP, WRAP, end = 8))
        tools.addView(ui.iconButton(R.drawable.ic_mic, "Ditado e gravação", C.TX2, bordered = false) { voiceMenu() }, ui.lp(dp(40), dp(40), end = 4))
        tools.addView(ImageButton(this).apply {
            setImageResource(R.drawable.ic_send); setColorFilter(C.LAV_DARK); contentDescription = "Enviar"
            background = ui.shape(C.LAV, 13); setOnClickListener { submit() }
        }, ui.lp(dp(42), dp(42)))
        box.addView(tools, ui.lp(top = 2))
        root.addView(box, ui.lp(start = 10, end = 10, top = 6, bottom = 8))
        composer.addTextChangedListener(object : android.text.TextWatcher {
            override fun afterTextChanged(s: android.text.Editable?) {
                prefs.edit().putString(draftKey(), s?.toString() ?: "").apply()
                steer.visibility = if (running() && !s.isNullOrBlank() && (account(currentAnswerer())?.str("provider") == "codex" || currentAnswerer() == "codex")) View.VISIBLE else View.GONE
            }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })
        updateLive()
        drawAttachments()
        if (threadId.isNotEmpty()) { readHistory(); readQueue(); readContext(); if (!isLocal()) readApprovals() }
        else history.addView(ui.text("Nova conversa em ${projectName.ifEmpty { "Geral" }}. A conversa também aparece no Web Harness.", 14f, C.TX3).apply { gravity = Gravity.CENTER }, ui.lp(top = 40))
    }

    private fun chatEmpty(root: LinearLayout) {
        root.addView(header("Codex Harness", "Conversa"))
        val box = ui.column().apply { gravity = Gravity.CENTER; setPadding(dp(28), 0, dp(28), dp(40)) }
        box.addView(ImageView(this).apply { setImageResource(R.drawable.ic_chat); setColorFilter(C.TX3) }, ui.lp(dp(44), dp(44)))
        box.addView(ui.text("Nenhuma conversa aberta", 17f, bold = true).apply { gravity = Gravity.CENTER }, ui.lp(WRAP, WRAP, top = 14))
        box.addView(ui.text("Abra uma conversa em Projetos ou comece uma nova.", 14f, C.TX2).apply { gravity = Gravity.CENTER }, ui.lp(WRAP, WRAP, top = 6, bottom = 18))
        box.addView(ui.action("+ Nova conversa", primary = true) { newConversationSheet() }, ui.lp(WRAP, dp(46)))
        box.addView(ui.action("Ver projetos") { show(TAB_PROJECTS) }, ui.lp(WRAP, dp(44), top = 10))
        root.addView(box, ui.lp(MATCH, 0, 1f))
    }

    private fun currentAnswerer(): String = allTurns().lastOrNull()?.optJSONObject("account")?.str("id")?.ifEmpty { null } ?: accountId

    private fun modelLabel(acc: JSONObject?): String {
        val m = model.ifEmpty { acc?.str("model").orEmpty() }
        val e = effort.ifEmpty { acc?.str("effort").orEmpty() }.ifEmpty { if (model.isEmpty()) defaultEfforts[acc?.str("id") ?: accountId].orEmpty() else "" }
        val (name, isDefault) = if (m.isNotEmpty()) prettyModel(m) to false else resolvedModel(acc)
        return listOf(acc?.str("label") ?: accountId, if (isDefault && name != "padrão da CLI") "$name (padrão)" else name, effortName(e)).filter { it.isNotBlank() }.joinToString(" · ")
    }
    private fun effortName(e: String) = mapOf("low" to "Baixo", "medium" to "Médio", "high" to "Alto", "xhigh" to "Muito alto", "minimal" to "Mínimo", "max" to "Máx.")[e] ?: e

    private fun updateLive() {
        if (!::liveText.isInitialized || tab != TAB_CHAT) return
        val turn = allTurns().lastOrNull()
        val busy = turn?.str("status") == "inProgress"
        val answerer = account(turn?.optJSONObject("account")?.str("id") ?: accountId) ?: account()
        val who = if (busy) listOf(answerer?.str("label") ?: "Agente", turn!!.str("model").takeIf { it.isNotBlank() }?.let { prettyModel(it) }.orEmpty()).filter { it.isNotBlank() }.joinToString(" · ") else modelLabel(account())
        val status = if (busy) " · trabalhando há ${duration(((System.currentTimeMillis() / 1000.0) - turn!!.optDouble("startedAt")).toLong() * 1000)}" else " · pronta"
        liveText.text = who + status
        liveDot.background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(if (busy) C.LAV else C.GREEN) }
        stopButton.visibility = if (busy) View.VISIBLE else View.GONE
        settingsChip.text = modelLabel(account())
        if (::steerButton.isInitialized && ::composer.isInitialized) steerButton.visibility = if (busy && composer.text.isNotBlank() && (account(currentAnswerer())?.str("provider") == "codex" || currentAnswerer() == "codex")) View.VISIBLE else View.GONE
        val transcribing = transcribingThread == threadId
        composerHint.visibility = if (busy || transcribing || voice.recording) View.VISIBLE else View.GONE
        composerHint.text = if (voice.recording) "Gravando · toque em Parar e transcrever ao terminar" else if (transcribing) "Transcrevendo o áudio… aguarde" else "Em execução · Enviar coloca na fila; Orientar altera a execução atual"
    }

    private fun readHistory(silent: Boolean = false, before: String = "") {
        if (threadId.isBlank() || historyPending) return
        historyPending = true
        val id = threadId
        request({ api.call("/api/threads/${enc(id)}/history" + if (before.isEmpty()) "" else "?cursor=${enc(before)}") },
            onError = { historyPending = false; if (!silent) ui.toast(it) }) { data ->
            historyPending = false
            if (id != threadId) return@request
            accessMode = data.str("accessMode")
            val turns = data.optJSONArray("turns").objects()
            data.optJSONObject("thread")?.let { t ->
                t.str("cwd").takeIf { it.isNotBlank() }?.let { threadCwd = it }
                val name = t.str("name").ifBlank { t.str("preview") }
                if (name.isNotBlank() && name != threadTitle) { threadTitle = name; saveThread() }
            }
            if (before.isEmpty()) {
                if (older.isNotEmpty()) {
                    val newIds = turns.map { it.str("id") }.toSet()
                    val oldIds = older.map { it.str("id") }.toSet()
                    older += latest.filter { it.str("id") !in newIds && it.str("id") !in oldIds }
                } else next = data.str("nextCursor")
                latest = turns
            } else { older = turns + older; next = data.str("nextCursor") }
            drawHistory(before.isNotEmpty())
        }
    }

    private fun drawContext() {
        if (!::contextBox.isInitialized || tab != TAB_CHAT) return
        contextBox.removeAllViews()
        if (threadId.isEmpty()) return
        val snapshot = contextSnapshot
        val usage = snapshot?.optJSONObject("tokenUsage") ?: snapshot
        val last = usage?.optJSONObject("last") ?: usage?.optJSONObject("lastTokenUsage")
        val used = if (last?.has("totalTokens") == true) last.optDouble("totalTokens", Double.NaN) else last?.optDouble("inputTokens", Double.NaN) ?: Double.NaN
        val capacity = usage?.optDouble("modelContextWindow", Double.NaN)?.takeIf { it.isFinite() } ?: usage?.optDouble("model_context_window", Double.NaN) ?: Double.NaN
        val valid = used.isFinite() && used >= 0 && capacity.isFinite() && capacity > 0
        val percent = if (valid) (100.0 * used / capacity).coerceIn(0.0, 100.0) else 0.0
        val row = ui.row()
        val ringColor = if (percent >= 90) C.RED else if (percent >= 75) C.AMBER else C.LAV
        val ring = object : View(this) {
            private val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                style = android.graphics.Paint.Style.STROKE; strokeWidth = dp(3).toFloat(); strokeCap = android.graphics.Paint.Cap.ROUND
            }
            override fun onDraw(canvas: android.graphics.Canvas) {
                super.onDraw(canvas)
                val inset = paint.strokeWidth / 2 + dp(1)
                val bounds = android.graphics.RectF(inset, inset, width - inset, height - inset)
                paint.color = C.LINE2; canvas.drawArc(bounds, 0f, 360f, false, paint)
                if (valid && percent > 0) { paint.color = ringColor; canvas.drawArc(bounds, -90f, (percent * 3.6).toFloat(), false, paint) }
            }
        }
        ring.contentDescription = if (valid) "Contexto: ${String.format(Locale("pt", "BR"), "%.1f", percent)} por cento usado" else "Contexto aguardando leitura"
        row.addView(ring, ui.lp(dp(24), dp(24), end = 8))
        row.addView(ui.text("Contexto", 11f, C.TX3), ui.lp(WRAP, WRAP, end = 8))
        row.addView(ui.text(if (valid) "${String.format(Locale("pt", "BR"), "%.1f", percent)}% usado" else "aguardando leitura", 11f, C.TX2), ui.lp(0, WRAP, 1f))
        row.addView(ui.text("ⓘ", 13f, C.TX3))
        contextBox.addView(row)
        contextBox.setOnClickListener {
            val fmt = java.text.NumberFormat.getIntegerInstance(Locale("pt", "BR"))
            val details = if (valid) "${fmt.format(used.toLong())} de ${fmt.format(capacity.toLong())} tokens usados; ${fmt.format((capacity - used).coerceAtLeast(0.0).toLong())} restantes. É uma estimativa do último turno e inclui instruções e ferramentas." else if (isLocal()) "Aguardando uma leitura de contexto da conta que está respondendo. Ela pode não estar disponível para este provedor ou após reiniciar o servidor." else "Aguardando uma leitura de tokens do servidor para esta conversa."
            AlertDialog.Builder(this).setTitle("Uso do contexto").setMessage(details).setPositiveButton("Entendi", null).show()
        }
    }

    private fun readContext() {
        if (threadId.isEmpty() || contextPending) return
        val id = threadId; contextPending = true
        request({ api.call("/api/threads/${enc(id)}/context-usage") }, onError = { contextPending = false }, scoped = false) {
            contextPending = false
            if (tab == TAB_CHAT && threadId == id) { contextSnapshot = it.optJSONObject("contextUsage"); drawContext() }
        }
    }

    private fun readApprovals() {
        if (threadId.isEmpty() || isLocal() || approvalsPending) return
        val id = threadId; approvalsPending = true
        request({ api.call("/api/bootstrap").optJSONArray("pending").objects() }, onError = { approvalsPending = false }, scoped = false) { requests ->
            approvalsPending = false
            if (tab != TAB_CHAT || threadId != id) return@request
            approvalBox.removeAllViews()
            requests.filter { it.optJSONObject("params")?.str("threadId") == id }.forEach { approval ->
                val params = approval.optJSONObject("params") ?: JSONObject()
                val requestId = approval.str("id")
                if (requestId.isBlank()) return@forEach
                val card = ui.card(0xff292116.toInt(), 0xff78582c.toInt(), 14, 12)
                card.addView(ui.text("Confirmação necessária", 14f, C.TX, bold = true))
                card.addView(ui.text(params.str("reason").ifBlank { "O Codex precisa da sua decisão para continuar." }, 12.5f, C.TX2), ui.lp(top = 6))
                val command = params.str("command").ifBlank { params.optJSONArray("commandActions").objects().joinToString("\n") { it.str("command") }.trim() }
                if (command.isNotBlank()) card.addView(ui.text(command, 12f, C.TX, mono = true).apply { setTextIsSelectable(true) }, ui.lp(top = 6))
                val actions = ui.column()
                listOf("Permitir agora" to "accept", "Permitir nesta sessão" to "acceptForSession", "Recusar" to "decline").forEach { (label, decision) ->
                    actions.addView(ui.action(label) {
                        request({ api.call("/api/threads/${enc(id)}/approval", obj("requestId" to requestId, "decision" to decision)) }) { ui.toast("Decisão enviada."); readApprovals() }
                    }, ui.lp(MATCH, dp(40), top = 5))
                }
                card.addView(actions); approvalBox.addView(card, ui.lp(bottom = 6))
            }
        }
    }

    private fun changeAccess(mode: String, dialog: android.app.Dialog) {
        if (mode == accessMode) return
        val id = threadId
        val explanation = if (mode == "automatic") "Comandos podem ser executados sem confirmação. Pedidos pendentes podem ser liberados; as permissões completas valem no próximo turno." else "Os próximos pedidos exigirão aprovação quando necessário. O turno atual conserva as permissões com que começou."
        AlertDialog.Builder(this).setTitle(if (mode == "automatic") "Ativar modo automático?" else "Pedir aprovação?").setMessage(explanation)
            .setPositiveButton("Confirmar") { _, _ ->
                request({ api.call("/api/threads/${enc(id)}/access-mode", obj("mode" to mode)) }) { result ->
                    if (threadId == id) { accessMode = result.str("mode"); dialog.dismiss(); settingsSheet(); readHistory(silent = true) }
                    ui.toast("Permissões atualizadas.")
                }
            }.setNegativeButton("Cancelar", null).show()
    }

    private fun readQueue() {
        if (threadId.isBlank()) return
        val id = threadId
        request({ api.call("/api/threads/${enc(id)}/queue").optJSONArray("items").objects() }, onError = {}) {
            if (id != threadId) return@request
            if (it.map { q -> q.str("id") } != queue.map { q -> q.str("id") }) { queue = it; drawQueue() }
        }
    }

    private fun queuedText(item: JSONObject): String = item.str("prompt").ifBlank {
        (item.optJSONArray("input") ?: item.optJSONObject("submission")?.optJSONArray("input")).objects()
            .filter { it.str("type") == "text" }.joinToString("\n") { it.str("text") }
    }.ifBlank { "Mensagem na fila" }

    private fun drawQueue() {
        if (!::queueBox.isInitialized) return
        queueBox.removeAllViews()
        for (item in queue) {
            val card = ui.card(0xff171a26.toInt(), 0xff33406a.toInt(), 14, 10)
            val top = ui.row()
            top.addView(ui.statusPill("info", "Na fila"))
            val created = item.optDouble("createdAt", 0.0)
            if (created > 0) top.addView(ui.text("  enviada às ${clockTime(created / 1000)}", 11f, C.TX3))
            card.addView(top)
            card.addView(ui.text(queuedText(item), 13.5f).apply { maxLines = 3; ellipsize = android.text.TextUtils.TruncateAt.END }, ui.lp(top = 6, bottom = 8))
            val actions = ui.row()
            actions.addView(ui.action("Orientar agora") {
                request({ api.call("/api/threads/${enc(threadId)}/queue/${enc(item.str("id"))}", JSONObject()) }) { readQueue(); readHistory(silent = true) }
            }, ui.lp(WRAP, dp(36), end = 8))
            actions.addView(ui.action("Remover") {
                request({ api.call("/api/threads/${enc(threadId)}/queue/${enc(item.str("id"))}", method = "DELETE") }) { readQueue() }
            }, ui.lp(WRAP, dp(36)))
            card.addView(actions)
            queueBox.addView(card, ui.lp(top = 6))
        }
    }

    private fun drawHistory(prepend: Boolean) {
        val turns = allTurns()
        val fingerprint = next + expanded + collapsed + turns.joinToString { it.toString() }
        updateLive()
        if (fingerprint == rendered) return
        rendered = fingerprint
        val previousHeight = history.height
        val previousY = scroll.scrollY
        val atBottom = previousHeight - (previousY + scroll.height) < dp(120)
        history.removeAllViews()
        if (next.isNotEmpty()) history.addView(ui.action("Carregar mensagens anteriores") { readHistory(before = next) }, ui.lp(WRAP, dp(40), bottom = 10).apply { gravity = Gravity.CENTER_HORIZONTAL })
        turns.forEachIndexed { index, turn -> drawTurn(turn, index == turns.lastIndex) }
        if (turns.isEmpty()) history.addView(ui.text("Sem mensagens ainda.", 14f, C.TX3), ui.lp(top = 30))
        if (!prepend && previousHeight > 0 && !atBottom) followLatest = followLatest && atBottom
        scroll.post {
            when {
                prepend -> scroll.scrollTo(0, previousY + history.height - previousHeight)
                followLatest || previousHeight == 0 -> { followLatest = true; scroll.scrollTo(0, (history.height - scroll.height).coerceAtLeast(0)) }
                else -> { scroll.scrollTo(0, previousY); if (history.height > previousHeight) unseenNew = true }
            }
            updateJump()
        }
    }

    private fun drawTurn(turn: JSONObject, isLast: Boolean) {
        val items = turn.optJSONArray("items").objects()
        val status = turn.str("status")
        val busy = status == "inProgress"
        val user = items.firstOrNull { it.str("type") == "userMessage" }
        if (user != null) userBubble(user, turn)
        val agents = items.filter { it.str("type") == "agentMessage" && it.str("text").isNotBlank() }
        val final = agents.lastOrNull { it.str("phase") == "final_answer" } ?: if (!busy) agents.lastOrNull() else null
        val steps = items.filter { it.str("type") in TOOL_TYPES || (it.str("type") == "userMessage" && it !== user) || (it.str("type") == "agentMessage" && it !== final && it.str("text").isNotBlank()) }
        if (steps.isNotEmpty() || busy) workCard(turn, steps, busy)
        if (final != null) {
            val acc = turn.optJSONObject("account")
            val box = ui.column()
            box.addView(ui.text(listOf(acc?.str("label")?.ifBlank { null } ?: "Codex", turn.str("model").takeIf { it.isNotBlank() }?.let { prettyModel(it) }.orEmpty()).filter { it.isNotBlank() }.joinToString(" · "), 11.5f, providerColor(acc?.str("provider").orEmpty()), bold = true), ui.lp(bottom = 4))
            md.render(final.str("text"), box)
            val completedAt = turn.optDouble("completedAt", 0.0)
            if (!busy && completedAt.isFinite() && completedAt > 0) box.addView(ui.text("Concluída em ${messageTime(completedAt)}", 11f, C.TX3), ui.lp(top = 4))
            val ms = turn.optLong("durationMs").takeIf { it > 0 } ?: ((turn.optDouble("completedAt") - turn.optDouble("startedAt")) * 1000).toLong()
            val footer = ui.row()
            if (ms > 0 && !busy) footer.addView(ui.pill("⏱ Trabalhou por ${duration(ms)}"), ui.lp(WRAP, WRAP, end = 6))
            val answerText = final.str("text")
            footer.addView(ui.pill("Copiar").apply { contentDescription = "Copiar resposta"; setPadding(dp(10), dp(4), dp(10), dp(4)); setOnClickListener { copyText(answerText) } })
            box.addView(footer, ui.lp(WRAP, WRAP, top = 2))
            history.addView(box, ui.lp(top = 4, bottom = 14))
            if (isLast && !busy) decision(final.str("text"))?.let { decisionCard(it) }
        }
        if (final == null && !busy && steps.isEmpty() && status in setOf("interrupted", "failed")) stopNotice(turn, user)
        else if (status == "failed" && !turn.isNull("error")) {
            val message = turn.optJSONObject("error")?.str("message") ?: turn.str("error")
            if (message.isNotBlank()) history.addView(ui.text(message, 12.5f, 0xffff9c9c.toInt()).apply {
                background = ui.shape(0xff221213.toInt(), 10, 1, 0xff3d1d1e.toInt()); setPadding(dp(10), dp(8), dp(10), dp(8))
            }, ui.lp(bottom = 12))
        }
    }

    private fun providerColor(provider: String) = when (provider) { "claude-code" -> C.ORANGE; "antigravity" -> C.CYAN; else -> C.LAV }

    private fun userBubble(item: JSONObject, turn: JSONObject) {
        val content = item.optJSONArray("content").objects()
        val raw = content.filter { it.str("type") == "text" }.joinToString("\n") { it.str("text") }
        val sentFiles = mutableListOf<Triple<String, String, String>>() // name, mime, api path
        val text = raw.replace(Regex("\\[Arquivo anexado]\\s*\\n([^\\n]+)\\n\\[/Arquivo anexado]")) { m ->
            runCatching {
                val f = JSONObject(m.groupValues[1]); val stored = f.str("path").substringAfterLast('/')
                if (f.str("name").isBlank() || !Regex("^[a-zA-Z0-9._-]{1,200}$").matches(stored)) m.value
                else { sentFiles += Triple(f.str("name"), f.str("mime").ifBlank { "application/octet-stream" }, "/api/files/${enc(threadId)}/${enc(stored)}?name=${enc(f.str("name"))}"); "" }
            }.getOrDefault(m.value)
        }.trim()
        val sentImages = content.filter { it.str("type") == "localImage" && it.str("path").isNotBlank() }.map { "/api/images/${enc(threadId)}/${enc(it.str("path").substringAfterLast('/'))}" }
        val attachments = 0
        val bubble = ui.column().apply { background = ui.shape(C.BLUE, 18, 1, C.BLUE_LINE).apply { cornerRadii = floatArrayOf(dp(18f), dp(18f), dp(18f), dp(18f), dp(6f), dp(6f), dp(18f), dp(18f)) }; setPadding(dp(14), dp(10), dp(14), dp(10)) }
        if (text.isNotBlank()) bubble.addView(ui.text(text.trim(), 15f, 0xffeef3ff.toInt()).apply { setTextIsSelectable(true) })
        if (sentImages.isNotEmpty() || sentFiles.isNotEmpty()) {
            val strip = ui.row()
            sentImages.forEach { path ->
                strip.addView(ImageView(this).apply {
                    scaleType = ImageView.ScaleType.CENTER_CROP; background = ui.shape(0xff1a2b4a.toInt(), 10); clipToOutline = true; outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
                    contentDescription = "Imagem enviada"; setOnClickListener { showApiImage(path, "Imagem enviada") }
                    loadApiImage(path, this)
                }, ui.lp(dp(92), dp(92), end = 6))
            }
            sentFiles.forEach { (name, mime, path) ->
                strip.addView(ui.text("📄 ${name.take(22)}", 12f, 0xffdbe4ff.toInt()).apply {
                    background = ui.shape(0xff1a2b4a.toInt(), 10, 1, 0xff3a5a90.toInt()); setPadding(dp(10), dp(8), dp(10), dp(8)); maxLines = 1
                    setOnClickListener { previewFile(name, mime) { api.bytes(path) } }
                }, ui.lp(WRAP, WRAP, end = 6))
            }
            bubble.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(strip) }, ui.lp(top = if (text.isNotBlank()) 8 else 0))
        }
        val queuedAt = turn.optDouble("queuedAt", 0.0)
        val startedAt = turn.optDouble("startedAt", 0.0)
        val stamp = if (queuedAt.isFinite() && queuedAt > 0) queuedAt else startedAt
        if (stamp.isFinite() && stamp > 0) {
            val prefix = if (queuedAt > 0) "Enviada" else "Início do turno"
            val waited = if (queuedAt > 0 && startedAt - queuedAt >= 5) " · esperou ${duration(((startedAt - queuedAt) * 1000).toLong())} na fila" else ""
            bubble.addView(ui.text("$prefix: ${messageTime(stamp)}$waited", 11f, 0xffaab6dc.toInt()).apply { gravity = Gravity.END }, ui.lp(top = 6))
        }
        history.addView(bubble, ui.lp(WRAP, WRAP, top = 6, bottom = 10, start = 40).apply { gravity = Gravity.END })
    }
    private fun dp(f: Float) = f * resources.displayMetrics.density

    /** "Trabalhando" card: every tool call of the turn, collapsible, newest state on top. */
    private fun workCard(turn: JSONObject, steps: List<JSONObject>, busy: Boolean) {
        val id = turn.str("id")
        val keepConversationVisible = steps.any { it.str("type") == "userMessage" || it.str("type") == "agentMessage" }
        val open = if (busy || keepConversationVisible) id !in collapsed else id in expanded
        val card = ui.card(C.PANEL, C.LINE, 16, 0)
        val head = ui.row().apply { setPadding(dp(12), dp(10), dp(12), dp(10)) }
        head.addView(ui.dot(if (busy) C.LAV else C.GREEN))
        val ms = if (busy) ((System.currentTimeMillis() / 1000.0 - turn.optDouble("startedAt")) * 1000).toLong()
        else turn.optLong("durationMs").takeIf { it > 0 } ?: 0
        head.addView(ui.text(if (busy) "Trabalhando" else "Trabalhou", 13f, bold = true), ui.lp(WRAP, WRAP, start = 8))
        if (ms > 0) head.addView(ui.text(" · ${duration(ms)}", 12.5f, C.TX3))
        head.addView(ui.space(), ui.lp(0, 1, 1f))
        head.addView(ui.text("${steps.size} etapa${if (steps.size == 1) "" else "s"} ${if (open) "▴" else "▾"}", 12f, C.TX3))
        head.setOnClickListener {
            if (busy || keepConversationVisible) { if (!collapsed.remove(id)) collapsed += id } else { if (!expanded.remove(id)) expanded += id }
            rendered = ""; drawHistory(false)
        }
        card.addView(head)
        if (open) {
            card.addView(View(this).apply { setBackgroundColor(C.LINE) }, ui.lp(MATCH, 1))
            val list = steps
            list.forEachIndexed { index, step -> card.addView(stepRow(step, busy && index == list.lastIndex)) }
            if (busy && steps.isEmpty()) card.addView(ui.text("Preparando…", 12.5f, C.TX3).apply { setPadding(dp(12), dp(10), dp(12), dp(12)) })
        }
        history.addView(card, ui.lp(bottom = 12))
    }

    private fun stepRow(item: JSONObject, current: Boolean): View {
        val type = item.str("type")
        if (type == "userMessage") {
            val text = item.optJSONArray("content").objects().filter { it.str("type") == "text" }.joinToString("\n") { it.str("text") }
            val wrap = ui.column().apply { setPadding(dp(12), dp(6), dp(12), dp(6)) }
            val bubble = ui.card(C.BLUE, C.BLUE_LINE, 12, 10)
            bubble.addView(ui.text("Sua orientação", 11.5f, 0xffb5c7ff.toInt(), bold = true), ui.lp(bottom = 5))
            bubble.addView(ui.text(text.ifBlank { "Orientação com anexo" }, 14f, C.TX).apply { setTextIsSelectable(true) })
            wrap.addView(bubble); return wrap
        }
        if (type == "agentMessage") {
            val wrap = ui.column().apply { setPadding(dp(12), dp(6), dp(12), dp(6)) }
            val card = ui.card(0xff1c2030.toInt(), 0xff303956.toInt(), 12, 10)
            card.addView(ui.text("Atualização do assistente", 11.5f, C.LAV, bold = true), ui.lp(bottom = 5))
            md.render(item.str("text"), card)
            wrap.addView(card); return wrap
        }
        val failed = item.str("status") in setOf("failed", "declined") || (item.has("exitCode") && item.optInt("exitCode", 0) != 0)
        val (title, detail, output) = when (type) {
            "userMessage" -> Triple("Sua orientação", item.optJSONArray("content").objects().filter { it.str("type") == "text" }.joinToString("\n") { it.str("text") }, null)
            "commandExecution" -> Triple("Executou comando", item.str("command"), item.opt("aggregatedOutput"))
            "fileChange" -> Triple("Alterou arquivos", item.optJSONArray("changes").objects().joinToString(", ") { it.str("path").substringAfterLast('/') }, item.opt("changes"))
            "webSearch" -> Triple("Pesquisou na web", item.str("query"), null)
            "mcpToolCall" -> Triple(toolTitle(item.str("tool")), item.str("server").ifBlank { "" }, item.opt("result") ?: item.opt("error"))
            "reasoning" -> Triple("Analisou", (item.optJSONArray("summary").strings().joinToString(" ")).take(140), null)
            "plan" -> Triple("Atualizou o plano", "", item.opt("text"))
            "agentMessage" -> Triple("Comentou", item.str("text").take(160), null)
            else -> Triple(type, "", null)
        }
        val box = ui.row().apply { gravity = Gravity.TOP; setPadding(dp(12), dp(8), dp(12), dp(8)) }
        box.addView(ui.text(if (current) "●" else if (failed) "✕" else "✓", 11f, if (current) C.LAV else if (failed) C.RED else C.GREEN, bold = true).apply {
            gravity = Gravity.CENTER
            background = ui.shape(if (current) 0xff1c1f3a.toInt() else if (failed) 0xff2c1515.toInt() else 0xff11281e.toInt(), 7, 1, if (current) 0xff3d4383.toInt() else if (failed) 0xff6b2a2a.toInt() else 0xff21513b.toInt())
        }, ui.lp(dp(22), dp(22), end = 10))
        val texts = ui.column()
        texts.addView(ui.text(title, 13f, if (current) C.TX else C.TX))
        val detailView = if (detail.isNotBlank()) ui.text(detail, 11.5f, 0xffc9cfdb.toInt(), mono = type == "commandExecution").apply {
            maxLines = if (type == "commandExecution") 1 else 3; ellipsize = android.text.TextUtils.TruncateAt.END
            if (type == "commandExecution") { background = ui.shape(0xff1d2128.toInt(), 6); setPadding(dp(6), dp(2), dp(6), dp(2)) }
        } else null
        if (detailView != null) texts.addView(detailView, ui.lp(WRAP, WRAP, top = 3))
        val outputText = when (output) { null, JSONObject.NULL -> ""; is JSONObject -> output.toString(2); is JSONArray -> output.toString(2); else -> output.toString() }.take(6000)
        if (outputText.isNotBlank()) {
            val out = ui.text(outputText, 11.5f, C.TX2, mono = true).apply {
                visibility = View.GONE; setTextIsSelectable(true); background = ui.shape(0xff101113.toInt(), 8); setPadding(dp(8), dp(6), dp(8), dp(6))
            }
            texts.addView(out, ui.lp(top = 6))
            box.setOnClickListener { out.visibility = if (out.visibility == View.VISIBLE) View.GONE else View.VISIBLE; if (type == "commandExecution") { detailView?.maxLines = if (out.visibility == View.VISIBLE) Int.MAX_VALUE else 1; detailView?.ellipsize = if (out.visibility == View.VISIBLE) null else android.text.TextUtils.TruncateAt.END } }
        } else if (type == "commandExecution" && detailView != null) {
            box.setOnClickListener { val expanded = detailView.maxLines == 1; detailView.maxLines = if (expanded) Int.MAX_VALUE else 1; detailView.ellipsize = if (expanded) null else android.text.TextUtils.TruncateAt.END }
        }
        box.addView(texts, ui.lp(0, WRAP, 1f))
        return box
    }
    private fun toolTitle(tool: String) = when {
        tool.equals("Read", true) -> "Leu arquivo"; tool.equals("Write", true) -> "Escreveu arquivo"; tool.equals("Edit", true) -> "Editou arquivo"
        tool.equals("Grep", true) || tool.equals("Glob", true) -> "Buscou no código"; tool.startsWith("mcp__") -> "Integração · ${tool.substringAfterLast("__")}"
        else -> "Ferramenta · $tool"
    }

    private fun stopNotice(turn: JSONObject, user: JSONObject?) {
        val status = turn.str("status")
        val prompt = user?.optJSONArray("content").objects().filter { it.str("type") == "text" }.joinToString("\n") { it.str("text") }.trim()
        val card = ui.row().apply {
            background = ui.shape(if (status == "failed") 0xff211515.toInt() else 0xff1f1a15.toInt(), 12, 1, if (status == "failed") 0xff5a2c2c.toInt() else 0xff4a3a2a.toInt())
            setPadding(dp(12), dp(10), dp(10), dp(10))
        }
        val texts = ui.column()
        texts.addView(ui.text(if (status == "failed") "Falhou antes de responder" else "Interrompida antes de responder", 13f, if (status == "failed") 0xffff9c9c.toInt() else 0xfff2c88a.toInt(), bold = true))
        val reason = turn.optJSONObject("error")?.str("message").orEmpty()
        texts.addView(ui.text(reason.ifBlank { if (status == "failed") "A conta não devolveu resposta." else "A execução foi encerrada (parada manual ou reinício do serviço). Nada foi executado." }, 12f, C.TX2), ui.lp(top = 2))
        card.addView(texts, ui.lp(0, WRAP, 1f, end = 8))
        if (prompt.isNotEmpty()) card.addView(ui.action("Reenviar") { composer.setText(prompt); composer.setSelection(prompt.length); composer.requestFocus() }, ui.lp(WRAP, dp(38)))
        history.addView(card, ui.lp(bottom = 14))
    }

    /** Same rule as the web: a question ending in "?" followed only by 2–6 list options. */
    private fun decision(text: String): Pair<String, List<String>>? {
        val lines = text.trim().lines()
        val option = Regex("^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)(?:\\[[ xX]]\\s*)?(.+?)\\s*$")
        val first = lines.indexOfFirst { option.matches(it) }
        if (first < 1) return null
        val question = lines.take(first).joinToString("\n").trim()
        if (!question.endsWith("?")) return null
        val options = mutableListOf<String>()
        for (line in lines.drop(first)) {
            if (line.isBlank()) continue
            val m = option.find(line) ?: return null
            options += m.groupValues[1].trim().ifEmpty { return null }
        }
        return if (options.size in 2..6) question to options else null
    }

    private fun decisionCard(d: Pair<String, List<String>>) {
        val card = ui.card(0xff161a26.toInt(), 0xff33406a.toInt(), 14, 12)
        card.addView(ui.caption("Escolha uma resposta"), ui.lp(bottom = 8))
        for (option in d.second) card.addView(ui.action(option) { composer.setText(option); submit() }.apply { gravity = Gravity.CENTER_VERTICAL or Gravity.START; setPadding(dp(14), dp(10), dp(14), dp(10)) }, ui.lp(top = 4))
        history.addView(card, ui.lp(bottom = 14))
    }

    private fun submit() {
        if (sendingMessage) { ui.toast("Aguarde o envio terminar."); return }
        val text = composer.text.toString().trim()
        if (text.isEmpty() && attachments.isEmpty()) return
        val body = obj("text" to text, "accountId" to accountId)
        val sending = attachments.toList()
        if (sending.isNotEmpty()) {
            body.put("images", JSONArray(sending.filter { it.image }.map { obj("name" to it.name, "mime" to it.mime, "data" to it.data) }))
            body.put("files", JSONArray(sending.filter { !it.image }.map { obj("name" to it.name, "mime" to it.mime, "data" to it.data) }))
        }
        if (threadId.isNotEmpty()) body.put("threadId", threadId) else if (newCwd.isNotEmpty()) body.put("cwd", newCwd)
        if (model.isNotEmpty()) body.put("model", model)
        if (effort.isNotEmpty()) body.put("effort", effort)
        val sendingThread = threadId
        val draftKey = draftKey(sendingThread)
        composer.isEnabled = false
        sendingMessage = true
        request({ api.call("/api/turn", body) }, onError = { sendingMessage = false; if (tab == TAB_CHAT && threadId == sendingThread) composer.isEnabled = true; ui.toast(it) }, scoped = false) {
            sendingMessage = false
            if (prefs.getString(draftKey, "")?.trim() == text) prefs.edit().remove(draftKey).apply()
            if (tab == TAB_CHAT && threadId == sendingThread) {
                composer.isEnabled = true
                if (composer.text.toString().trim() == text) composer.text.clear()
            scrollToLatest()
            }
            attachments.removeAll(sending); if (tab == TAB_CHAT && threadId == sendingThread) drawAttachments()
            val created = it.str("threadId")
            if (created.isNotBlank() && threadId == sendingThread && created != threadId) { threadId = created; newCwd = ""; saveThread() }
            if (it.optBoolean("queued")) ui.toast("Mensagem na fila: entra quando a resposta atual terminar.")
            if (tab == TAB_CHAT && (threadId == sendingThread || threadId == created)) { readHistory(); readQueue() }
        }
    }

    private fun steer() {
        val text = composer.text.toString().trim()
        if (text.isEmpty() || threadId.isEmpty()) return
        request({ api.call("/api/threads/${enc(threadId)}/steer", obj("text" to text)) }) { composer.text.clear(); ui.toast("Orientação enviada à execução atual."); readHistory(silent = true) }
    }

    private fun interrupt() {
        if (threadId.isEmpty()) return
        AlertDialog.Builder(this).setTitle("Parar a execução?").setMessage("O agente para no ponto em que está. O que já foi feito continua feito.")
            .setPositiveButton("Parar") { _, _ -> request({ api.call("/api/threads/${enc(threadId)}/interrupt", JSONObject()) }) { readHistory() } }
            .setNegativeButton("Continuar", null).show()
    }

    private fun menuOption(body: LinearLayout, title: String, note: String, action: () -> Unit) {
        val card = ui.card(C.CARD, C.LINE, 14, 12)
        card.addView(ui.text(title, 14f, C.TX, bold = true))
        card.addView(ui.text(note, 12f, C.TX3), ui.lp(top = 3))
        card.setOnClickListener { action() }
        body.addView(card, ui.lp(bottom = 8))
    }

    private fun threadMenu() {
        if (threadId.isEmpty()) return
        val id = threadId
        ui.sheet("Opções da conversa") { body, dialog ->
            menuOption(body, "Renomear", "Alterar o título desta conversa") { dialog.dismiss(); renameThread(id, threadTitle) { threadTitle = it; saveThread(); show(TAB_CHAT) } }
            menuOption(body, "Atualizar", "Recarregar mensagens e fila") { dialog.dismiss(); rendered = ""; readHistory(); readQueue(); readContext() }
            menuOption(body, "Abrir no Web Harness", "Continuar esta conversa no navegador") { dialog.dismiss(); openLink("$BASE/#thread=$id") }
            val pinned = id in pinnedIds
            menuOption(body, if (pinned) "Desafixar" else "Fixar", if (pinned) "Tirar da seção Fixadas" else "Manter no topo, na seção Fixadas") { dialog.dismiss(); setPinned(id, !pinned) }
            menuOption(body, "Copiar última resposta", "Texto da resposta mais recente") {
                dialog.dismiss()
                allTurns().flatMap { it.optJSONArray("items").objects() }.lastOrNull { it.str("type") == "agentMessage" && it.str("text").isNotBlank() }?.let { copyText(it.str("text")) } ?: ui.toast("Ainda não há resposta para copiar.")
            }
            menuOption(body, "Arquivar", "Retirar da lista de conversas recentes") {
                dialog.dismiss()
                AlertDialog.Builder(this).setTitle("Arquivar conversa?").setMessage("Você poderá encontrá-la em conversas arquivadas.")
                    .setPositiveButton("Arquivar") { _, _ -> request({ api.call("/api/threads/${enc(id)}/archive", JSONObject()) }) { ui.toast("Conversa arquivada."); if (threadId == id) { threadId = ""; threadTitle = ""; saveThread(); show(TAB_PROJECTS) } } }
                    .setNegativeButton("Cancelar", null).show()
            }
            menuOption(body, "Excluir", "Apagar a conversa de vez") { dialog.dismiss(); deleteThread(id, threadTitle) }
        }
    }

    private val pinnedIds = mutableSetOf<String>()
    private val PINNED_SECTION = "01984de2-8f74-7c91-a3b2-5c5e937cf318"
    private fun isPinned(t: JSONObject) = t.optJSONObject("section")?.str("id") == PINNED_SECTION

    private fun setPinned(id: String, pinned: Boolean) = request({ api.call("/api/threads/${enc(id)}/pin", obj("pinned" to pinned)) }) {
        if (pinned) pinnedIds += id else pinnedIds -= id
        ui.toast(if (pinned) "Conversa fixada." else "Conversa desafixada.")
        if (tab == TAB_PROJECTS) show(TAB_PROJECTS)
    }

    private fun deleteThread(id: String, title: String) {
        AlertDialog.Builder(this).setTitle("Excluir conversa?").setMessage("\"${title.take(80)}\" e as mensagens dela serão apagadas. Não dá para desfazer.")
            .setPositiveButton("Excluir") { _, _ ->
                request({ api.call("/api/threads/${enc(id)}/delete", method = "DELETE") }) {
                    ui.toast("Conversa excluída.")
                    pinnedIds -= id
                    if (threadId == id) { threadId = ""; threadTitle = ""; saveThread() }
                    show(TAB_PROJECTS)
                }
            }.setNegativeButton("Cancelar", null).show()
    }

    private fun copyText(text: String) {
        (getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("Codex Harness", text))
        if (Build.VERSION.SDK_INT < 33) ui.toast("Copiado.")
    }

    private fun renameThread(id: String, current: String, done: (String) -> Unit) {
        val input = ui.field("Nome da conversa").apply { setText(current) }
        AlertDialog.Builder(this).setTitle("Renomear").setView(FrameLayout(this).apply { setPadding(dp(20), dp(8), dp(20), 0); addView(input) })
            .setPositiveButton("Salvar") { _, _ ->
                val name = input.text.toString().trim()
                if (name.isNotEmpty()) request({ api.call("/api/threads/${enc(id)}/rename", obj("name" to name)) }) { done(name) }
            }.setNegativeButton("Cancelar", null).show()
    }

    /** Ajustes: account, model and effort for the next messages. */
    private fun settingsSheet() {
        if (accounts.isEmpty()) { loadAccounts { settingsSheet() }; return }
        ui.sheet("Ajustes da mensagem") { body, dialog ->
            val accountBox = ui.column()
            val modelsBox = ui.column()
            if (threadId.isNotEmpty() && !isLocal()) {
                body.addView(ui.caption("Permissões nesta conversa"), ui.lp(top = 6, bottom = 8))
                val accessChoices = ui.column(); body.addView(accessChoices)
                fun renderAccess() {
                    accessChoices.removeAllViews()
                    accessChoices.addView(ui.flow(listOf(
                        ui.choice("Pedir aprovação", accessMode == "manual") { changeAccess("manual", dialog) },
                        ui.choice("Automático", accessMode == "automatic") { changeAccess("automatic", dialog) }
                    )))
                    accessChoices.addView(ui.text((if (accessMode.isEmpty()) "O servidor não informou o modo atual." else "Modo atual: ${if (accessMode == "automatic") "Automático" else "Pedir aprovação"}") + if (isLocal()) "\nPara contas secundárias, pedidos interativos podem ser recusados pelo servidor." else "", 11.5f, C.TX3), ui.lp(top = 4))
                }
                renderAccess()
            }
            body.addView(ui.caption("Conta"), ui.lp(top = 12, bottom = 8))
            body.addView(accountBox)
            body.addView(ui.caption("Modelo"), ui.lp(top = 16, bottom = 8))
            body.addView(modelsBox)
            var catalogVersion = 0
            lateinit var refreshAccounts: () -> Unit
            lateinit var loadModels: () -> Unit
            refreshAccounts = {
                accountBox.removeAllViews()
                accountBox.addView(ui.flow(accounts.filter { it.optBoolean("enabled") }.map { acc ->
                    val label = acc.str("label") + if (!acc.optBoolean("available")) " · ${acc.str("unavailableReason").ifBlank { "indisponível" }}" else ""
                    ui.choice(label, acc.str("id") == accountId) {
                        if (accountId != acc.str("id")) { accountId = acc.str("id"); model = ""; effort = ""; saveSelection(); refreshAccounts(); loadModels(); updateLive() }
                    }
                }))
            }
            loadModels = {
                val requestedAccount = accountId
                val version = ++catalogVersion
                modelsBox.removeAllViews(); modelsBox.addView(ui.text("Carregando modelos…", 13f, C.TX3))
                request({ api.call("/api/accounts/${enc(requestedAccount)}/models") }, onError = { if (version == catalogVersion && dialog.isShowing) { modelsBox.removeAllViews(); modelsBox.addView(ui.text("Não consegui listar os modelos: $it", 12.5f, C.TX3)) } }) { catalog ->
                    if (version == catalogVersion && dialog.isShowing) {
                        val models = catalog.optJSONArray("models").objects()
                        lateinit var renderModels: () -> Unit
                        renderModels = {
                            modelsBox.removeAllViews()
                            val current = model.ifEmpty { account()?.str("model").orEmpty() }
                            val chips = mutableListOf<View>(ui.choice(resolvedModelFor(requestedAccount).let { "Padrão da conta · $it" }, model.isEmpty()) { model = ""; effort = ""; saveSelection(); renderModels(); updateLive() })
                            models.forEach { m -> chips += ui.choice(m.str("label").ifBlank { m.str("id") }, model.isNotEmpty() && m.str("id") == current) { model = m.str("id"); effort = m.str("defaultEffort"); saveSelection(); renderModels(); updateLive() } }
                            modelsBox.addView(ui.flow(chips))
                            val selected = models.firstOrNull { it.str("id") == current }
                            val efforts = selected?.optJSONArray("efforts").strings().ifEmpty { if (account()?.str("provider") == "codex") listOf("low", "medium", "high", "xhigh") else emptyList() }
                            if (efforts.isNotEmpty()) {
                                modelsBox.addView(ui.caption("Esforço"), ui.lp(top = 16, bottom = 8))
                                modelsBox.addView(ui.flow(efforts.map { e -> ui.choice(effortName(e), e == effort.ifEmpty { account()?.str("effort").orEmpty() }) { effort = e; saveSelection(); renderModels(); updateLive() } }))
                            }
                            catalog.str("note").takeIf { it.isNotBlank() }?.let { modelsBox.addView(ui.text(it, 11.5f, C.TX3), ui.lp(top = 12)) }
                        }
                        renderModels()
                    }
                }
            }
            refreshAccounts(); loadModels()
            val auto = ui.row().apply { setPadding(0, dp(14), 0, 0) }
            val autoTexts = ui.column(); autoTexts.addView(ui.text("Enviar áudio direto", 13.5f))
            val description = ui.text("", 11.5f, C.TX3); autoTexts.addView(description)
            auto.addView(autoTexts, ui.lp(0, WRAP, 1f))
            val toggle = Switch(this).apply { isChecked = prefs.getBoolean("voiceAutoSend", false); contentDescription = "Enviar áudio direto" }
            fun updateDescription(on: Boolean) { description.text = if (on) "Ligado: envia o texto após a transcrição" else "Desligado: revise o texto transcrito antes de enviar" }
            updateDescription(toggle.isChecked)
            toggle.setOnCheckedChangeListener { _, on -> prefs.edit().putBoolean("voiceAutoSend", on).apply(); updateDescription(on) }
            autoTexts.setOnClickListener { toggle.isChecked = !toggle.isChecked }
            auto.addView(toggle); body.addView(auto)
            body.addView(ui.action("Pronto", primary = true) { dialog.dismiss() }, ui.lp(MATCH, dp(46), top = 18))
        }
    }

    // ───────────────────────── Voice ─────────────────────────

    private fun voiceMenu() {
        if (transcribingThread != null) { ui.toast("Aguarde a transcrição terminar."); return }
        ui.sheet("Mensagem por voz") { body, dialog ->
            val saved = java.io.File(prefs.getString("pendingVoicePath", "").orEmpty())
            if (saved.isFile && saved.parentFile == cacheDir) menuOption(body, "Retomar áudio pendente", "Tentar novamente a transcrição da gravação preservada") {
                dialog.dismiss(); transcribeRecording(saved, prefs.getBoolean("pendingVoiceSend", false), prefs.getString("pendingVoiceThread", "").orEmpty(), prefs.getString("pendingVoiceDraft", "").orEmpty())
            }
            menuOption(body, "Ditado do celular", "Usa o serviço de voz configurado no Android; pode usar internet") { dialog.dismiss(); startPhoneDictation() }
            menuOption(body, "Gravar e transcrever no servidor", "Grave até 3 minutos; o texto será processado na VPS") { dialog.dismiss(); startRecording() }
        }
    }

    private fun startPhoneDictation() {
        val intent = Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, "pt-BR")
            putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "Fale sua mensagem")
        }
        dictationThread = threadId; dictationDraft = draftKey()
        runCatching { @Suppress("DEPRECATION") startActivityForResult(intent, DICTATE_PHONE) }
            .onFailure { ui.toast("Ditado indisponível. Use a gravação no servidor ou o microfone do teclado.") }
    }

    private fun startRecording() {
        val pending = java.io.File(prefs.getString("pendingVoicePath", "").orEmpty())
        if (pending.isFile && pending.parentFile == cacheDir) { ui.toast("Retome ou descarte o áudio pendente antes de gravar outro."); return }
        if (transcribingThread != null) { ui.toast("Aguarde a transcrição terminar."); return }
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), ASK_MIC); return
        }
        runCatching { voice.start() }.onFailure { ui.toast("Não consegui usar o microfone: ${it.message}"); return }
        showRecording(true)
        clock.post(meter)
    }

    private fun showRecording(on: Boolean) {
        if (!::recordingBar.isInitialized) return
        recordingBar.visibility = if (on) View.VISIBLE else View.GONE
        composerRow.visibility = if (on) View.GONE else View.VISIBLE
        composer.visibility = if (on) View.GONE else View.VISIBLE
        composerHint.visibility = if (on) View.VISIBLE else if (running()) View.VISIBLE else View.GONE
        composerHint.text = if (on) "Gravando · toque em Parar e transcrever ao terminar" else "Em execução · Enviar coloca na fila; Orientar altera a execução atual"
        window.decorView.keepScreenOn = on
    }

    private fun finishRecording(send: Boolean) {
        clock.removeCallbacks(meter)
        val file = voice.stop()
        showRecording(false)
        if (file == null) { ui.toast("Gravação curta demais. Tente novamente."); return }
        transcribeRecording(file, send, threadId, draftKey())
    }

    private fun transcribeRecording(file: java.io.File, send: Boolean, voiceThread: String, voiceDraft: String) {
        transcribingThread = voiceThread
        prefs.edit().putString("pendingVoicePath", file.absolutePath).putString("pendingVoiceThread", voiceThread).putString("pendingVoiceDraft", voiceDraft).putBoolean("pendingVoiceSend", send).apply()
        val waitView = ui.column().apply { setPadding(dp(24), dp(16), dp(24), dp(20)); gravity = Gravity.CENTER_HORIZONTAL }
        waitView.addView(ProgressBar(this@MainActivity), ui.lp(dp(48), dp(48), bottom = 14))
        waitView.addView(ui.text("Transcrevendo áudio…", 16f, C.TX, bold = true))
        waitView.addView(ui.text("Aguarde. O tempo depende da duração do áudio e do servidor.", 12.5f, C.TX2).apply { gravity = Gravity.CENTER }, ui.lp(top = 8))
        val waiting = AlertDialog.Builder(this).setView(waitView).setCancelable(false).create()
        waiting.setCanceledOnTouchOutside(false); waiting.show()
        worker.execute {
            val result = runCatching {
                val data = android.util.Base64.encodeToString(file.readBytes(), android.util.Base64.NO_WRAP)
                val job = api.call("/api/voice/transcriptions", obj("mime" to "audio/mp4", "data" to data))
                val id = job.str("id"); var answer = job
                val deadline = System.currentTimeMillis() + 310_000
                while (answer.str("status") == "processing" && System.currentTimeMillis() < deadline) {
                    Thread.sleep(900); answer = api.call("/api/voice/transcriptions/${enc(id)}")
                }
                if (answer.str("status") == "processing") error("A transcrição ainda não terminou. Tente novamente mais tarde.")
                if (answer.str("status") != "completed") error(answer.str("error").ifBlank { "Não consegui transcrever o áudio." })
                answer.str("text").trim().ifEmpty { error("Não identifiquei fala no áudio.") }
            }
            runOnUiThread {
                transcribingThread = null
                if (isFinishing || isDestroyed) return@runOnUiThread
                waiting.dismiss()
                result.onSuccess { text ->
                    file.delete(); prefs.edit().remove("pendingVoicePath").remove("pendingVoiceThread").remove("pendingVoiceDraft").remove("pendingVoiceSend").apply()
                    if (tab == TAB_CHAT && threadId == voiceThread && draftKey() == voiceDraft) {
                        val current = composer.text.toString().trim()
                        composer.setText(listOf(current, text).filter { it.isNotEmpty() }.joinToString(" ")); composer.setSelection(composer.text.length)
                        updateLive(); if (send) submit()
                    } else {
                        val old = prefs.getString(voiceDraft, "").orEmpty().trim()
                        prefs.edit().putString(voiceDraft, listOf(old, text).filter { it.isNotEmpty() }.joinToString(" ")).apply()
                        if (voiceThread.isEmpty()) {
                            AlertDialog.Builder(this).setTitle("Transcrição concluída").setMessage(text)
                                .setPositiveButton("Copiar texto") { _, _ -> (getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("Transcrição", text)); ui.toast("Texto copiado.") }
                                .setNegativeButton("Fechar", null).show()
                        } else ui.toast("Transcrição salva no rascunho da conversa.")
                    }
                }.onFailure { error ->
                    if (error is SessionExpired) { login(error.message.orEmpty()); ui.toast("O áudio ficou guardado no cache do app.") }
                    else AlertDialog.Builder(this).setTitle("Não consegui transcrever").setMessage("${error.message ?: "Falha de conexão."}\n\nA gravação está preservada neste aparelho.")
                        .setPositiveButton("Tentar novamente") { _, _ -> transcribeRecording(file, send, voiceThread, voiceDraft) }
                        .setNegativeButton("Descartar áudio") { _, _ -> file.delete(); prefs.edit().remove("pendingVoicePath").remove("pendingVoiceThread").remove("pendingVoiceDraft").remove("pendingVoiceSend").apply() }.setCancelable(false).show()
                }
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == ASK_NOTIFY) {
            if (grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED) setNotifications(true)
            else { prefs.edit().putBoolean("notifications", false).apply(); ui.toast("Sem permissão de notificações. Libere em Configurações › Apps › Codex Harness.") }
            return
        }
        if (requestCode == ASK_MIC) {
            if (grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED) startRecording()
            else ui.toast("Sem acesso ao microfone. Libere em Configurações › Apps › Codex Harness.")
        }
    }

    // ───────────────────────── Attachments ─────────────────────────

    private fun attachMenu() {
        ui.sheet("Adicionar à mensagem") { body, dialog ->
            body.addView(ui.text("Escolha até 8 fotos ou arquivos, com 24 MB no total.", 12.5f, C.TX2), ui.lp(bottom = 12))
            fun choose(images: Boolean) {
                dialog.dismiss()
                val intent = if (images) Intent(Intent.ACTION_GET_CONTENT).setType("image/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                else Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                runCatching { @Suppress("DEPRECATION") startActivityForResult(intent, if (images) PICK_IMAGES else PICK_FILES) }.onFailure { ui.toast("Nenhum app para escolher arquivos.") }
            }
            menuOption(body, "Fotos e imagens", "Escolher imagens da galeria ou de arquivos") { choose(true) }
            menuOption(body, "Arquivos", "Escolher documentos e outros arquivos") { choose(false) }
        }
    }

    @Deprecated("Activity result callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == DICTATE_PHONE) {
            if (resultCode != RESULT_OK || data == null) return
            val text = data.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim().orEmpty()
            if (text.isEmpty()) { ui.toast("Não identifiquei fala. Tente novamente."); return }
            if (tab == TAB_CHAT && threadId == dictationThread && draftKey() == dictationDraft) {
                val current = composer.text.toString().trim(); composer.setText(listOf(current, text).filter { it.isNotEmpty() }.joinToString(" ")); composer.setSelection(composer.text.length)
                if (prefs.getBoolean("voiceAutoSend", false)) submit()
            } else {
                val old = prefs.getString(dictationDraft, "").orEmpty().trim(); prefs.edit().putString(dictationDraft, listOf(old, text).filter { it.isNotEmpty() }.joinToString(" ")).apply(); ui.toast("Ditado salvo no rascunho da conversa.")
            }
            return
        }
        if (resultCode != RESULT_OK || data == null || requestCode !in setOf(PICK_IMAGES, PICK_FILES)) return
        val uris = data.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } } ?: listOfNotNull(data.data)
        addAttachmentUris(uris)
    }

    /** Shared by the picker and by paste (long-press ▸ Colar, keyboard clipboard, keyboard images). */
    private fun addAttachmentUris(uris: List<Uri>) {
        worker.execute {
            val added = mutableListOf<Attachment>(); var problem = ""
            for (uri in uris) {
                if (attachments.size + added.size >= 8) { problem = "Máximo de 8 anexos por mensagem."; break }
                runCatching { readAttachment(uri) }.onSuccess { added += it }.onFailure { problem = it.message ?: "Não consegui ler um arquivo." }
            }
            runOnUiThread {
                val total = (attachments + added).sumOf { it.size }
                if (total > 24L * 1024 * 1024) ui.toast("O limite é 24 MB por mensagem.")
                else { attachments += added; drawAttachments() }
                if (problem.isNotEmpty()) ui.toast(problem)
            }
        }
    }

    private fun readAttachment(uri: Uri): Attachment {
        var name = "arquivo"; var size = -1L
        contentResolver.query(uri, null, null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { name = c.getString(it) ?: name }
                c.getColumnIndex(android.provider.OpenableColumns.SIZE).takeIf { it >= 0 }?.let { size = c.getLong(it) }
            }
        }
        if (size > 20L * 1024 * 1024) error("$name passa de 20 MB.")
        var mime = contentResolver.getType(uri) ?: "application/octet-stream"
        var bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: error("Não consegui abrir $name.")
        val image = mime.startsWith("image/")
        if (image && (bytes.size > 3 * 1024 * 1024 || mime !in setOf("image/png", "image/jpeg", "image/webp", "image/gif"))) {
            // Large photos: resize to 2048 px JPEG, as the web composer does.
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            var sample = 1
            while (bounds.outWidth / sample > 4096 || bounds.outHeight / sample > 4096) sample *= 2
            val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: error("Imagem inválida: $name")
            val scale = minOf(1f, 2048f / maxOf(decoded.width, decoded.height))
            val scaled = if (scale < 1f) Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt(), (decoded.height * scale).toInt(), true) else decoded
            bytes = java.io.ByteArrayOutputStream().use { out -> scaled.compress(Bitmap.CompressFormat.JPEG, 86, out); out.toByteArray() }
            mime = "image/jpeg"; name = name.substringBeforeLast('.') + ".jpg"
        }
        return Attachment(name, mime, android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP), image, bytes.size.toLong())
    }

    private fun drawAttachments() {
        if (!::attachmentStrip.isInitialized) return
        attachmentStrip.removeAllViews()
        for (file in attachments.toList()) {
            val tile = FrameLayout(this)
            val bytes = { android.util.Base64.decode(file.data, android.util.Base64.NO_WRAP) }
            if (file.image) {
                val thumb = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP; background = ui.shape(C.CARD2, 12); clipToOutline = true; outlineProvider = android.view.ViewOutlineProvider.BACKGROUND }
                tile.addView(thumb, FrameLayout.LayoutParams(dp(72), dp(72)))
                worker.execute { val bmp = runCatching { decodeSampled(bytes(), 240) }.getOrNull(); runOnUiThread { bmp?.let { thumb.setImageBitmap(it) } } }
            } else {
                tile.addView(ui.column().apply {
                    gravity = Gravity.CENTER; background = ui.shape(C.CARD2, 12, 1, C.LINE2); setPadding(dp(6), dp(6), dp(6), dp(6))
                    addView(ui.text(file.name.substringAfterLast('.', "arq").take(5).uppercase(), 13f, C.LAV, bold = true).apply { gravity = Gravity.CENTER })
                    addView(ui.text(file.name, 9.5f, C.TX2).apply { maxLines = 2; gravity = Gravity.CENTER; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE }, ui.lp(top = 2))
                }, FrameLayout.LayoutParams(dp(72), dp(72)))
            }
            tile.contentDescription = "Prévia de ${file.name}"
            tile.setOnClickListener { previewFile(file.name, file.mime, bytes) }
            tile.addView(ui.text("✕", 11f, Color.WHITE, bold = true).apply {
                gravity = Gravity.CENTER; contentDescription = "Remover ${file.name}"
                background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(0xdd101218.toInt()); setStroke(dp(1), C.LINE2) }
                setOnClickListener { attachments.remove(file); drawAttachments() }
            }, FrameLayout.LayoutParams(dp(24), dp(24), Gravity.TOP or Gravity.END).apply { setMargins(0, dp(3), dp(3), 0) })
            attachmentStrip.addView(tile, ui.lp(WRAP, WRAP, end = 8, top = 6))
        }
    }

    // ───────────────────────── In-app update ─────────────────────────

    private fun installUpdate(release: JSONObject) {
        if (!updater.canInstall()) {
            AlertDialog.Builder(this).setTitle("Permitir atualizações do app")
                .setMessage("Para instalar a nova versão sem passar pelo navegador, o Android precisa que você permita que o Codex Harness instale apps. Ative a opção e volte aqui.")
                .setPositiveButton("Abrir configurações") { _, _ -> updater.openInstallPermission() }
                .setNegativeButton("Depois", null).show()
            return
        }
        val status = ui.text("Baixando a versão ${release.str("versionName")}… 0%", 14f, C.TX2).apply { setPadding(dp(24), dp(18), dp(24), dp(8)) }
        val dialog = AlertDialog.Builder(this).setTitle("Atualizando").setView(status).setCancelable(false).show()
        worker.execute {
            val result = runCatching { updater.downloadAndInstall(release) { p -> runOnUiThread { status.text = "Baixando a versão ${release.str("versionName")}… $p%" } } }
            runOnUiThread {
                dialog.dismiss()
                result.onSuccess { ui.toast("Confirme a instalação na janela do Android.") }
                result.onFailure { ui.toast(it.message ?: "A atualização falhou.") }
            }
        }
    }

    private fun newConversationSheet(initialCwd: String = "") {
        val start = {
            ui.sheet("Nova conversa") { body, dialog ->
                var cwd = initialCwd
                body.addView(ui.text("A conversa começa sem mensagens anteriores. As instruções globais do servidor continuam valendo.", 12f, C.TX2), ui.lp(bottom = 10))
                body.addView(ui.caption("Projeto"), ui.lp(top = 6, bottom = 8))
                val projectBox = ui.column()
                fun drawProjects() {
                    projectBox.removeAllViews()
                    val chips = mutableListOf<View>(ui.choice("Sem projeto", cwd.isEmpty()) { cwd = ""; drawProjects() })
                    projects.forEach { p -> chips += ui.choice(p.str("name").ifBlank { p.str("cwd").substringAfterLast('/') }, cwd == p.str("cwd")) { cwd = p.str("cwd"); drawProjects() } }
                    projectBox.addView(ui.flow(chips))
                }
                drawProjects()
                body.addView(projectBox)
                body.addView(ui.action("+ Criar projeto") { dialog.dismiss(); createProjectSheet() }, ui.lp(MATCH, dp(44), top = 8))
                body.addView(ui.caption("Conta"), ui.lp(top = 16, bottom = 8))
                val accountBox = ui.column()
                fun drawAccounts() {
                    accountBox.removeAllViews()
                    accountBox.addView(ui.flow(accounts.filter { it.optBoolean("enabled") && it.optBoolean("available") }.map { acc ->
                        ui.choice(acc.str("label"), acc.str("id") == accountId) { accountId = acc.str("id"); model = ""; effort = ""; saveSelection(); drawAccounts() }
                    }))
                }
                drawAccounts()
                body.addView(accountBox)
                body.addView(ui.action("Começar conversa", primary = true) {
                    dialog.dismiss()
                    threadId = ""; threadTitle = "Nova conversa"; threadCwd = cwd; newCwd = cwd; newDraftId = java.util.UUID.randomUUID().toString(); contextSnapshot = null; accessMode = ""
                    older = emptyList(); latest = emptyList(); queue = emptyList(); next = ""; rendered = ""
                    saveThread(); show(TAB_CHAT)
                    composer.requestFocus()
                }, ui.lp(MATCH, dp(48), top = 20))
            }
        }
        if (projects.isEmpty() || accounts.isEmpty()) request({ api.call("/api/projects").optJSONArray("projects").objects() to api.call("/api/accounts") }) { (p, a) ->
            projects = p; accounts = a.optJSONArray("accounts").objects(); rotation = a.optJSONObject("rotation") ?: JSONObject(); start()
        } else start()
    }

    private fun createProjectSheet() {
        request({ api.call("/api/bootstrap").str("projectsRoot") }) { root ->
            if (!root.startsWith("/")) { ui.toast("Não consegui descobrir a pasta de projetos."); return@request }
            ui.sheet("Criar projeto") { body, dialog ->
                body.addView(ui.text("Uma pasta nova será criada no servidor em $root.", 12.5f, C.TX2), ui.lp(bottom = 10))
                body.addView(ui.caption("Nome do projeto"), ui.lp(bottom = 6))
                val name = ui.field("Ex.: Meu projeto"); body.addView(name)
                body.addView(ui.caption("Nome da pasta"), ui.lp(top = 12, bottom = 6))
                val folder = ui.field("Ex.: meu-projeto"); body.addView(folder)
                body.addView(ui.text("Use letras minúsculas, números e hífens.", 11.5f, C.TX3), ui.lp(top = 5))
                lateinit var save: TextView
                save = ui.action("Criar e iniciar conversa", primary = true) {
                    if (!save.isEnabled) return@action
                    val label = name.text.toString().trim(); val slug = folder.text.toString().trim()
                    if (label.isBlank() || (slug.length > 63 || !slug.matches(Regex("[a-z0-9]+(?:-[a-z0-9]+)*")))) { ui.toast("Informe o nome e uma pasta válida."); return@action }
                    save.isEnabled = false
                    request({ api.call("/api/projects", obj("name" to label, "cwd" to "$root/$slug", "createDirectory" to true)) }, onError = { save.isEnabled = true; ui.toast(it) }) { data ->
                        save.isEnabled = true
                        projects = data.optJSONArray("projects").objects()
                        val created = data.optJSONObject("project")?.str("cwd").orEmpty()
                        dialog.dismiss(); if (created.isNotEmpty()) newConversationSheet(created) else ui.toast("Projeto criado. Escolha-o na lista.")
                    }
                }
                body.addView(save, ui.lp(MATCH, dp(48), top = 18))
            }
        }
    }

    private fun projectFor(cwd: String): String {
        if (cwd.isBlank()) return ""
        return projects.firstOrNull { it.str("cwd") == cwd }?.str("name")?.ifBlank { null } ?: cwd.substringAfterLast('/')
    }

    // ───────────────────────── Links, images and previews ─────────────────────────

    private fun localUrl(path: String) = "/api/local-files?path=${enc(path)}&preview=1"

    private fun openLink(url: String) {
        when {
            url.startsWith("http://") || url.startsWith("https://") -> runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }.onFailure { ui.toast("Não consegui abrir o link.") }
            url.removePrefix("file://").startsWith("/home/") -> {
                val path = url.removePrefix("file://")
                when {
                    Regex("\\.(png|jpe?g|webp|gif)$", RegexOption.IGNORE_CASE).containsMatchIn(path) -> showImage(path, path.substringAfterLast('/'))
                    Regex("\\.html?$", RegexOption.IGNORE_CASE).containsMatchIn(path) -> showPreview(path, path.substringAfterLast('/'))
                    else -> showWeb("$BASE/api/local-files?path=${enc(path)}", path.substringAfterLast('/'))
                }
            }
            else -> ui.toast("Link não suportado no app: $url")
        }
    }

    private fun loadImage(path: String, view: ImageView) = loadApiImage(localUrl(path), view)

    /** Any authenticated image path (/api/local-files, /api/images, /api/files), cached by path. */
    private fun loadApiImage(apiPath: String, view: ImageView) {
        images.get(apiPath)?.let { view.setImageBitmap(it); return }
        view.setImageDrawable(ui.shape(0xff1a1d24.toInt(), 10))
        worker.execute {
            val bitmap = runCatching { decodeSampled(api.bytes(apiPath), 1600) }.getOrNull()
            runOnUiThread {
                if (bitmap != null) { images.put(apiPath, bitmap); view.setImageBitmap(bitmap) }
                else view.contentDescription = "Imagem indisponível"
            }
        }
    }

    private fun decodeSampled(bytes: ByteArray, maxPx: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (bounds.outWidth / sample > maxPx || bounds.outHeight / sample > maxPx) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }


    private fun fullscreen(build: (FrameLayout, Dialog) -> Unit) {
        val dialog = Dialog(this, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
        val frame = FrameLayout(this).apply { setBackgroundColor(0xf2050608.toInt()) }
        build(frame, dialog)
        frame.addView(ui.text("✕", 20f, Color.WHITE).apply {
            setPadding(dp(16), dp(12), dp(16), dp(12)); contentDescription = "Fechar"; setOnClickListener { dialog.dismiss() }
        }, FrameLayout.LayoutParams(WRAP, WRAP, Gravity.TOP or Gravity.END))
        dialog.setContentView(frame)
        dialog.show()
    }

    private fun showImage(path: String, caption: String) = showApiImage(localUrl(path), caption)

    /** Full-screen image with pinch zoom and double tap; one tap toggles the caption. */
    private fun showApiImage(apiPath: String, caption: String, bitmap: Bitmap? = null) = fullscreen { frame, _ ->
        lateinit var label: TextView
        val image = ZoomImageView(this) { label.visibility = if (label.visibility == View.VISIBLE) View.GONE else View.VISIBLE }.apply { contentDescription = caption }
        frame.addView(image, FrameLayout.LayoutParams(MATCH, MATCH))
        label = ui.text(caption.ifBlank { "Toque duas vezes para ampliar" }, 13f, C.TX2).apply { setPadding(dp(16), dp(12), dp(16), dp(24)); setBackgroundColor(0x99000000.toInt()) }
        frame.addView(label, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.BOTTOM))
        if (bitmap != null) image.setImageBitmap(bitmap) else loadApiImage(apiPath, image)
    }

    /**
     * In-app file viewer: images (zoom), PDF (pages rendered natively), text and code; anything else
     * shows its details. Bytes come from the composer (not sent yet) or from the server.
     */
    private fun previewFile(name: String, mime: String, load: () -> ByteArray) = fullscreen { frame, _ ->
        val column = ui.column()
        val head = ui.column().apply { setPadding(dp(16), dp(14), dp(60), dp(10)) }
        head.addView(ui.text(name, 15f, bold = true).apply { maxLines = 2 })
        val meta = ui.text(mime, 11.5f, C.TX3)
        head.addView(meta)
        column.addView(head)
        val area = FrameLayout(this)
        column.addView(area, ui.lp(MATCH, 0, 1f))
        area.addView(ProgressBar(this), FrameLayout.LayoutParams(WRAP, WRAP, Gravity.CENTER))
        frame.addView(column, FrameLayout.LayoutParams(MATCH, MATCH))
        val lower = name.lowercase()
        val isText = mime.startsWith("text/") || mime in setOf("application/json", "application/xml", "application/javascript", "application/x-sh") ||
            Regex("\\.(txt|md|json|csv|log|kt|kts|java|js|mjs|ts|tsx|jsx|py|sh|yml|yaml|xml|html|css|sql|gradle|env|ini|toml)$").containsMatchIn(lower)
        worker.execute {
            val result = runCatching {
                val bytes = load()
                when {
                    mime.startsWith("image/") -> decodeSampled(bytes, 2400) ?: error("Imagem inválida.")
                    mime == "application/pdf" || lower.endsWith(".pdf") -> renderPdf(bytes)
                    isText -> String(bytes, Charsets.UTF_8).let { if (it.length > 300_000) it.take(300_000) + "\n\n… (cortado)" else it }
                    else -> bytes.size
                } to bytes.size
            }
            runOnUiThread {
                area.removeAllViews()
                result.onFailure { area.addView(ui.text("Não consegui abrir: ${it.message}", 14f, C.RED).apply { setPadding(dp(16), dp(16), dp(16), dp(16)) }) }
                result.onSuccess { (content, size) ->
                    meta.text = "$mime · ${size / 1024} KB"
                    when (content) {
                        is Bitmap -> area.addView(ZoomImageView(this) {}.apply { setImageBitmap(content) }, FrameLayout.LayoutParams(MATCH, MATCH))
                        is String -> area.addView(ScrollView(this).apply { addView(HorizontalScrollView(this@MainActivity).apply { addView(ui.text(content, 12.5f, 0xffc9cfdb.toInt(), mono = true).apply { setTextIsSelectable(true); setPadding(dp(14), dp(8), dp(14), dp(30)) }) }) }, FrameLayout.LayoutParams(MATCH, MATCH))
                        is List<*> -> {
                            val pages = ui.column().apply { setPadding(dp(10), 0, dp(10), dp(30)) }
                            content.filterIsInstance<Bitmap>().forEachIndexed { i, page ->
                                pages.addView(ImageView(this).apply { setImageBitmap(page); adjustViewBounds = true; setBackgroundColor(Color.WHITE); setOnClickListener { showApiImage("", "$name · página ${i + 1}", page) } }, ui.lp(bottom = 10))
                            }
                            if (content.size >= 30) pages.addView(ui.text("Mostrando as 30 primeiras páginas.", 12f, C.TX3))
                            area.addView(ScrollView(this).apply { addView(pages) }, FrameLayout.LayoutParams(MATCH, MATCH))
                        }
                        else -> area.addView(ui.column().apply {
                            gravity = Gravity.CENTER; setPadding(dp(30), 0, dp(30), 0)
                            addView(ui.text("📄", 44f).apply { gravity = Gravity.CENTER })
                            addView(ui.text("Sem prévia para este tipo de arquivo.", 14f, C.TX2).apply { gravity = Gravity.CENTER }, ui.lp(top = 10))
                            addView(ui.text("Ele vai anexado normalmente; o agente lê o arquivo no servidor.", 12.5f, C.TX3).apply { gravity = Gravity.CENTER }, ui.lp(top = 4))
                        }, FrameLayout.LayoutParams(MATCH, MATCH))
                    }
                }
            }
        }
    }

    private fun renderPdf(bytes: ByteArray): List<Bitmap> {
        val file = java.io.File(cacheDir, "preview-${System.nanoTime()}.pdf")
        file.writeBytes(bytes)
        try {
            android.os.ParcelFileDescriptor.open(file, android.os.ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
                android.graphics.pdf.PdfRenderer(fd).use { pdf ->
                    val width = resources.displayMetrics.widthPixels - dp(20)
                    return (0 until minOf(pdf.pageCount, 30)).map { index ->
                        pdf.openPage(index).use { page ->
                            val height = (width.toFloat() * page.height / page.width).toInt()
                            Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { bmp ->
                                bmp.eraseColor(Color.WHITE)
                                page.render(bmp, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            }
                        }
                    }
                }
            }
        } finally { file.delete() }
    }

    private fun showPreview(path: String, label: String) = showWeb(BASE + localUrl(path), label)

    /** The server's preview CSP continues to isolate HTML from the Harness session. */
    private fun showWeb(url: String, title: String) {
        CookieManager.getInstance().apply { setAcceptCookie(true); api.sessionCookie().takeIf { it.isNotEmpty() }?.let { setCookie(ORIGIN, it) }; flush() }
        val dialog = Dialog(this, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
        val web = WebView(this).apply {
            @Suppress("SetJavaScriptEnabled")
            settings.javaScriptEnabled = true
            settings.useWideViewPort = true; settings.loadWithOverviewMode = false
            settings.builtInZoomControls = true; settings.displayZoomControls = false
            settings.allowFileAccess = false; settings.allowContentAccess = false
            setInitialScale(100)
            setBackgroundColor(C.BG)
            webViewClient = object : android.webkit.WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                    val target = request.url
                    if (target.scheme == "https" && target.host == Uri.parse(ORIGIN).host) return false
                    if (target.scheme == "https" || target.scheme == "http") openLink(target.toString())
                    return true
                }
            }
        }
        val column = ui.column().apply { setBackgroundColor(C.BG) }
        val toolbar = ui.row().apply { setPadding(dp(8), dp(6), dp(8), dp(6)) }
        toolbar.addView(ui.iconButton(R.drawable.ic_back, "Voltar na prévia") { if (web.canGoBack()) web.goBack() else dialog.dismiss() }, ui.lp(dp(42), dp(42)))
        toolbar.addView(ui.text(title, 14f, C.TX, bold = true).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; setPadding(dp(8), 0, dp(8), 0) }, ui.lp(0, WRAP, 1f))
        toolbar.addView(ui.iconButton(R.drawable.ic_refresh, "Recarregar prévia") { web.reload() }, ui.lp(dp(42), dp(42)))
        toolbar.addView(ui.text("✕", 20f, C.TX).apply { gravity = Gravity.CENTER; contentDescription = "Fechar prévia"; setOnClickListener { dialog.dismiss() } }, ui.lp(dp(42), dp(42)))
        column.addView(toolbar)
        column.addView(web, ui.lp(MATCH, 0, 1f))
        dialog.setContentView(column)
        dialog.setOnKeyListener { _, keyCode, event ->
            if (keyCode == android.view.KeyEvent.KEYCODE_BACK && event.action == android.view.KeyEvent.ACTION_UP) {
                if (web.canGoBack()) web.goBack() else dialog.dismiss()
                true
            } else keyCode == android.view.KeyEvent.KEYCODE_BACK
        }
        dialog.setOnDismissListener { web.stopLoading(); (web.parent as? android.view.ViewGroup)?.removeView(web); web.destroy() }
        dialog.show()
        web.loadUrl(url)
    }

    // ───────────────────────── Projects tab ─────────────────────────

    private fun projectsTab() {
        val root = page()
        root.addView(header("Codex Web Harness", "Projetos", ui.iconButton(R.drawable.ic_plus, "Nova conversa") { newConversationSheet() }))
        val tools = ui.column().apply { setPadding(dp(14), 0, dp(14), dp(8)) }
        val search = ui.field("Buscar conversas…").apply {
            setText(query); imeOptions = EditorInfo.IME_ACTION_SEARCH
            setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.ic_search, 0, 0, 0); compoundDrawablePadding = dp(8)
            compoundDrawablesRelative[0]?.setTint(C.TX3)
            setOnEditorActionListener { _, _, _ -> query = text.toString().trim(); show(TAB_PROJECTS); true }
        }
        val newActions = ui.row()
        newActions.addView(ui.action("+ Nova conversa") { newConversationSheet() }, ui.lp(0, dp(44), 1f, end = 6))
        newActions.addView(ui.action("+ Novo projeto") { createProjectSheet() }, ui.lp(0, dp(44), 1f))
        tools.addView(newActions, ui.lp(bottom = 10))
        tools.addView(search)
        tools.addView(ui.segmented(listOf("Recentes", "Arquivadas"), if (archived) 1 else 0) { archived = it == 1; show(TAB_PROJECTS) }, ui.lp(top = 10))
        root.addView(tools)
        val list = ui.column().apply { setPadding(dp(14), dp(4), dp(14), dp(20)) }
        root.addView(ScrollView(this).apply { addView(list) }, ui.lp(MATCH, 0, 1f))
        list.addView(ui.text("Carregando…", 13.5f, C.TX3))
        request({ api.call("/api/threads?archived=$archived&search=${enc(query)}").optJSONArray("threads").objects() to api.call("/api/projects").optJSONArray("projects").objects() },
            onError = { list.removeAllViews(); list.addView(ui.text(it, 13.5f, C.RED)) }) { (threads, folders) ->
            projects = folders
            rememberTitles(threads.associate { it.str("id") to (it.str("name").ifBlank { it.str("preview") }) }.filterValues { it.isNotBlank() })
            list.removeAllViews()
            if (threads.isEmpty() && folders.isEmpty()) list.addView(ui.text(if (query.isEmpty()) "Nenhuma conversa ainda." else "Nada encontrado para \"$query\".", 14f, C.TX3), ui.lp(top = 20))
            val used = mutableSetOf<String>()
            val groups = folders.mapNotNull { p ->
                val ids = p.optJSONArray("threadIds").strings().toSet()
                val inside = threads.filter { it.str("id") in ids || (it.str("cwd").isNotBlank() && it.str("cwd") == p.str("cwd")) }.filter { used.add(it.str("id")) }
                if (inside.isEmpty() && (archived || query.isNotBlank())) null else p to inside
            }.sortedByDescending { (_, t) -> t.maxOfOrNull { it.optDouble("updatedAt", 0.0) } ?: 0.0 }
            val loose = threads.filter { it.str("id") !in used }
            pinnedIds.clear(); pinnedIds += threads.filter { isPinned(it) }.map { it.str("id") }
            val pinnedThreads = threads.filter { isPinned(it) }
            if (pinnedThreads.isNotEmpty() && !archived) {
                list.addView(ui.caption("Fixadas"), ui.lp(top = 4, bottom = 6))
                val box = ui.card(C.CARD, C.LINE, 16, 0)
                pinnedThreads.forEachIndexed { i, t -> if (i > 0) box.addView(View(this).apply { setBackgroundColor(C.LINE) }, ui.lp(MATCH, 1, start = 12, end = 12)); box.addView(threadRow(t)) }
                list.addView(box, ui.lp(bottom = 12))
            }
            if (threadId.isNotEmpty() && !archived) threads.firstOrNull { it.str("id") == threadId }?.let { current ->
                list.addView(ui.caption("Aberta"), ui.lp(top = 4, bottom = 6))
                list.addView(threadRow(current, highlight = true).apply { background = ui.shape(0xff161a26.toInt(), 14, 1, 0xff33406a.toInt()) }, ui.lp(bottom = 12))
            }
            for ((project, inside) in groups) projectCard(list, project.str("name").ifBlank { project.str("cwd").substringAfterLast('/') }, inside, project.str("cwd"))
            if (loose.isNotEmpty()) projectCard(list, "Sem projeto", loose)
            val footer = ui.card(C.CARD, C.LINE, 16, 10).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            footer.addView(ui.text("C", 14f, Color.WHITE, bold = true).apply { gravity = Gravity.CENTER; background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(0xff4b3fb5.toInt()) } }, ui.lp(dp(32), dp(32), end = 10))
            val names = ui.column()
            names.addView(ui.text("Conta Codex", 13.5f, bold = true)); names.addView(ui.text("Acesso privado", 11.5f, C.TX3))
            footer.addView(names, ui.lp(0, WRAP, 1f))
            footer.addView(ui.pill("Sair").apply { setOnClickListener { logout() } })
            list.addView(footer, ui.lp(top = 12))
        }
    }

    private fun projectCard(list: LinearLayout, name: String, threads: List<JSONObject>, cwd: String = "") {
        val key = "open:$name"
        var open = prefs.getBoolean(key, threads.size <= 4 || name == projectFor(threadCwd))
        val card = ui.card(C.CARD, C.LINE, 16, 0)
        val head = ui.row().apply { setPadding(dp(12), dp(11), dp(12), dp(11)) }
        head.addView(ImageView(this).apply { setImageResource(R.drawable.ic_folder); setColorFilter(if (threads.any { it.optJSONObject("status")?.str("type") == "active" }) C.LAV else C.TX2) }, ui.lp(dp(20), dp(20), end = 10))
        head.addView(ui.text(name, 14f, bold = true).apply { maxLines = 1 }, ui.lp(0, WRAP, 1f))
        if (threads.any { it.optJSONObject("status")?.str("type") == "active" }) head.addView(ui.dot(C.LAV), ui.lp(dp(7), dp(7), end = 8))
        head.addView(ui.text("${threads.size}", 12f, C.TX3), ui.lp(WRAP, WRAP, end = 6))
        val arrow = ui.text(if (open) "⌃" else "⌄", 14f, C.TX3)
        head.addView(arrow)
        card.addView(head)
        val rows = ui.column()
        threads.sortedByDescending { it.optDouble("updatedAt", 0.0) }.forEach { t ->
            rows.addView(View(this).apply { setBackgroundColor(C.LINE) }, ui.lp(MATCH, 1, start = 12, end = 12))
            rows.addView(threadRow(t))
        }
        if (cwd.isNotEmpty() && !archived) rows.addView(ui.action("+ Conversa neste projeto") { newConversationSheet(cwd) }, ui.lp(MATCH, dp(42), start = 10, end = 10, bottom = 8, top = 8))
        rows.visibility = if (open) View.VISIBLE else View.GONE
        card.addView(rows)
        head.setOnClickListener { open = !open; prefs.edit().putBoolean(key, open).apply(); rows.visibility = if (open) View.VISIBLE else View.GONE; arrow.text = if (open) "⌃" else "⌄" }
        list.addView(card, ui.lp(bottom = 10))
    }

    private fun threadRow(t: JSONObject, highlight: Boolean = false): View {
        val title = t.str("name").ifBlank { t.str("preview") }.ifBlank { "Conversa sem título" }
        val box = ui.row().apply { setPadding(dp(14), dp(10), dp(12), dp(10)) }
        val active = t.optJSONObject("status")?.str("type") == "active"
        box.addView(ui.dot(if (active) C.LAV else if (highlight) C.GREEN else 0xff3a3f4a.toInt(), 7), ui.lp(dp(7), dp(7), end = 10))
        val texts = ui.column()
        texts.addView(ui.text(title, 13.5f, if (highlight) C.TX else C.TX).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END })
        val updated = t.optDouble("updatedAt", 0.0)
        val acc = account(t.str("accountId"))?.str("label") ?: t.str("model")
        texts.addView(ui.text(listOf(if (active) "respondendo" else "", if (updated > 0) ago((updated * 1000).toLong()) else "", acc).filter { it.isNotBlank() }.joinToString(" · "), 11f, C.TX3).apply { maxLines = 1 }, ui.lp(top = 1))
        box.addView(texts, ui.lp(0, WRAP, 1f))
        box.setOnClickListener { openThread(t.str("id"), title, t.str("cwd"), t.str("accountId")) }
        box.setOnLongClickListener {
            val id = t.str("id")
            ui.sheet(title) { body, dialog ->
                menuOption(body, "Abrir", "Continuar esta conversa") { dialog.dismiss(); openThread(id, title, t.str("cwd"), t.str("accountId")) }
                menuOption(body, if (isPinned(t)) "Desafixar" else "Fixar", if (isPinned(t)) "Tirar da seção Fixadas" else "Manter no topo, na seção Fixadas") { dialog.dismiss(); setPinned(id, !isPinned(t)) }
                menuOption(body, "Renomear", "Alterar o título") { dialog.dismiss(); renameThread(id, title) { show(TAB_PROJECTS) } }
                menuOption(body, if (archived) "Desarquivar" else "Arquivar", if (archived) "Voltar para as recentes" else "Retirar das recentes") { dialog.dismiss(); request({ api.call("/api/threads/${enc(id)}/${if (archived) "unarchive" else "archive"}", JSONObject()) }) { show(TAB_PROJECTS) } }
                menuOption(body, "Excluir", "Apagar a conversa de vez") { dialog.dismiss(); deleteThread(id, title) }
            }; true
        }
        return box
    }

    private fun logout() {
        AlertDialog.Builder(this).setTitle("Sair da conta?").setPositiveButton("Sair") { _, _ ->
            request({ runCatching { api.call("/api/auth/logout", JSONObject()) }; api.clear() }) { threadId = ""; saveThread(); login() }
        }.setNegativeButton("Cancelar", null).show()
    }

    // ───────────────────────── Tasks tab (execuções contínuas) ─────────────────────────

    private var taskList: LinearLayout? = null

    private fun tasksTab(refreshOnly: Boolean = false) {
        if (!refreshOnly) {
            val root = page()
            root.addView(header("Automação", "Execuções contínuas", ui.iconButton(R.drawable.ic_plus, "Nova execução") { newTaskSheet() }))
            taskList = ui.column().apply { setPadding(dp(14), 0, dp(14), dp(20)) }
            root.addView(ScrollView(this).apply { addView(taskList) }, ui.lp(MATCH, 0, 1f))
            taskList!!.addView(ui.text("Carregando…", 13.5f, C.TX3))
        }
        request({ api.call("/api/tasks").optJSONArray("tasks").objects() }, onError = { if (!refreshOnly) { taskList?.removeAllViews(); taskList?.addView(ui.text(it, 13.5f, C.RED)) } }) { tasks ->
            val failed = tasks.count { it.str("status") in setOf("failed", "blocked") }
            if (failed != failedTasks) { failedTasks = failed; drawTabs() }
            val list = taskList ?: return@request
            list.removeAllViews()
            val active = tasks.filter { it.str("status") in setOf("running", "queued", "waiting") }
            list.addView(ui.segmented(listOf("Todas ${tasks.size}", "Ativas ${active.size}", "Falhas $failed"), taskFilter) { taskFilter = it; tasksTab(refreshOnly = true) }, ui.lp(bottom = 12))
            val shown = when (taskFilter) { 1 -> active; 2 -> tasks.filter { it.str("status") in setOf("failed", "blocked") }; else -> tasks }
            if (shown.isEmpty()) list.addView(ui.text(if (tasks.isEmpty()) "Nenhuma execução contínua ainda. Toque em + para criar: o agente segue sozinho até o objetivo, trocando de conta quando o limite de uso chegar." else "Nada neste filtro.", 14f, C.TX3), ui.lp(top = 10))
            for (task in shown) list.addView(taskCard(task), ui.lp(bottom = 8))
        }
    }

    private fun taskStatus(status: String) = when (status) {
        "running" -> "info" to "Em andamento"; "queued" -> "info" to "Na fila"; "waiting" -> "warn" to "Aguardando janela"
        "completed" -> "ok" to "Concluída"; "failed" -> "bad" to "Falhou"; "blocked" -> "bad" to "Bloqueada"; "stopped" -> "" to "Parada"; else -> "" to status
    }

    private fun taskCard(task: JSONObject): View {
        val (kind, label) = taskStatus(task.str("status"))
        val failed = kind == "bad"
        val card = ui.card(C.CARD, if (failed) 0xff4a2626.toInt() else C.LINE, 16, 12)
        val top = ui.row()
        top.addView(ui.text(task.str("title"), 14f, bold = true).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }, ui.lp(0, WRAP, 1f, end = 8))
        top.addView(ui.statusPill(kind, label))
        card.addView(top)
        val meta = listOf("${task.optInt("segmentCount")} etapa(s)", task.str("currentAccountLabel"), projectFor(task.str("cwd")), ago(task.optLong("updatedAt"))).filter { it.isNotBlank() }.joinToString(" · ")
        card.addView(ui.text(meta, 11.5f, C.TX3), ui.lp(top = 5))
        val error = task.str("error").ifBlank { if (failed) task.str("lastOutcome") else "" }
        if (error.isNotBlank()) card.addView(ui.text(error.take(220), 11f, 0xffff9c9c.toInt(), mono = true).apply {
            background = ui.shape(0xff221213.toInt(), 10, 1, 0xff3d1d1e.toInt()); setPadding(dp(10), dp(8), dp(10), dp(8))
        }, ui.lp(top = 9))
        if (task.str("status") == "waiting" && task.optLong("nextAttemptAt") > 0) card.addView(ui.text("Próxima tentativa às ${clockTime(task.optLong("nextAttemptAt") / 1000.0)}", 11.5f, C.AMBER), ui.lp(top = 6))
        card.setOnClickListener { taskDetail(task.str("id")) }
        return card
    }

    private fun taskDetail(id: String) {
        request({ api.call("/api/tasks/${enc(id)}").getJSONObject("task") }) { task ->
            val (kind, label) = taskStatus(task.str("status"))
            ui.sheet(task.str("title")) { body, dialog ->
                val top = ui.row(); top.addView(ui.statusPill(kind, label)); top.addView(ui.text("  ${projectFor(task.str("cwd"))}", 12f, C.TX3)); body.addView(top, ui.lp(bottom = 10))
                body.addView(ui.caption("Objetivo"), ui.lp(bottom = 6))
                body.addView(ui.text(task.str("goal").take(1200), 13.5f, C.TX2).apply { setTextIsSelectable(true) }, ui.lp(bottom = 14))
                val segments = task.optJSONArray("segments").objects()
                if (segments.isNotEmpty()) {
                    body.addView(ui.caption("Etapas"), ui.lp(bottom = 8))
                    segments.takeLast(12).forEach { s ->
                        val ok = s.str("outcome") == "completed"
                        val line = ui.row().apply { gravity = Gravity.TOP }
                        line.addView(ui.text(if (ok) "✓" else if (s.str("outcome").isEmpty()) "●" else "!", 11f, if (ok) C.GREEN else if (s.str("outcome").isEmpty()) C.LAV else C.AMBER, bold = true).apply { gravity = Gravity.CENTER; background = ui.shape(0xff1d2128.toInt(), 12) }, ui.lp(dp(24), dp(24), end = 10))
                        val texts = ui.column()
                        texts.addView(ui.text(account(s.str("accountId"))?.str("label") ?: s.str("accountId").ifBlank { "Conta" }, 13f))
                        texts.addView(ui.text(listOf(s.str("outcome").ifBlank { "em andamento" }, s.str("summary").take(140)).filter { it.isNotBlank() }.joinToString(" · "), 11.5f, C.TX3))
                        line.addView(texts, ui.lp(0, WRAP, 1f))
                        body.addView(line, ui.lp(bottom = 10))
                    }
                }
                task.str("error").takeIf { it.isNotBlank() }?.let { body.addView(ui.text(it, 11.5f, 0xffff9c9c.toInt(), mono = true).apply { background = ui.shape(0xff221213.toInt(), 10); setPadding(dp(10), dp(8), dp(10), dp(8)) }, ui.lp(bottom = 12)) }
                val actions = ui.row()
                val status = task.str("status")
                if (status in setOf("running", "queued", "waiting")) actions.addView(ui.action("Parar") {
                    request({ api.call("/api/tasks/${enc(id)}/stop", JSONObject()) }) { dialog.dismiss(); tasksTab(refreshOnly = true) }
                }, ui.lp(0, dp(44), 1f, end = 8))
                else actions.addView(ui.action("Retomar", primary = true) {
                    request({ api.call("/api/tasks/${enc(id)}/resume", obj("note" to "")) }) { dialog.dismiss(); tasksTab(refreshOnly = true) }
                }, ui.lp(0, dp(44), 1f, end = 8))
                if (task.str("threadId").isNotBlank()) actions.addView(ui.action("Abrir conversa") { dialog.dismiss(); openThread(task.str("threadId"), task.str("title"), task.str("cwd")) }, ui.lp(0, dp(44), 1f))
                body.addView(actions, ui.lp(top = 6))
            }
        }
    }

    private fun newTaskSheet() {
        val open = {
            ui.sheet("Nova execução contínua") { body, dialog ->
                body.addView(ui.text("O agente trabalha sozinho até concluir o objetivo, trocando de conta quando o limite de uso chega.", 12.5f, C.TX3), ui.lp(bottom = 12))
                body.addView(ui.caption("Objetivo"), ui.lp(bottom = 6))
                val goal = ui.field("Ex.: Termine a migração do checkout, rode os testes e deixe pronto para revisão.", multi = true).apply { minLines = 4; gravity = Gravity.TOP }
                body.addView(goal)
                var cwd = threadCwd
                body.addView(ui.caption("Projeto"), ui.lp(top = 14, bottom = 8))
                val box = ui.column()
                fun draw() {
                    box.removeAllViews()
                    val chips = mutableListOf<View>(ui.choice("Sem projeto", cwd.isEmpty()) { cwd = ""; draw() })
                    projects.forEach { p -> chips += ui.choice(p.str("name").ifBlank { p.str("cwd").substringAfterLast('/') }, cwd == p.str("cwd")) { cwd = p.str("cwd"); draw() } }
                    box.addView(ui.flow(chips))
                }
                draw(); body.addView(box)
                body.addView(ui.action("Iniciar execução", primary = true) {
                    val text = goal.text.toString().trim()
                    if (text.isEmpty()) { ui.toast("Descreva o objetivo."); return@action }
                    val data = obj("goal" to text); if (cwd.isNotEmpty()) data.put("cwd", cwd)
                    request({ api.call("/api/tasks", data) }) { dialog.dismiss(); ui.toast("Execução criada."); tasksTab(refreshOnly = true) }
                }, ui.lp(MATCH, dp(48), top = 18))
            }
        }
        if (projects.isEmpty()) request({ api.call("/api/projects").optJSONArray("projects").objects() }) { projects = it; open() } else open()
    }

    // ───────────────────────── Overview tab ─────────────────────────

    private fun overviewTab() {
        val root = page()
        root.addView(header("Visão geral", "Uso e ambiente", ui.iconButton(R.drawable.ic_refresh, "Atualizar") { show(TAB_OVERVIEW) }, ui.iconButton(R.drawable.ic_more, "Menu") { appMenu() }))
        val list = ui.column().apply { setPadding(dp(14), 0, dp(14), dp(20)) }
        root.addView(ScrollView(this).apply { addView(list) }, ui.lp(MATCH, 0, 1f))
        val tools = ui.row()
        tools.addView(ui.action("Saúde da VPS  ›") { serverHealthSheet() }, ui.lp(0, dp(46), 1f, end = 8))
        tools.addView(ui.action("Terminal  ›") { terminalScreen() }, ui.lp(0, dp(46), 1f))
        root.addView(tools, 1, ui.lp(MATCH, WRAP, start = 14, end = 14, bottom = 10))
        list.addView(ui.text("Carregando contas…", 13.5f, C.TX3))
        request({ api.call("/api/accounts") }, onError = { list.removeAllViews(); list.addView(ui.text(it, 13.5f, C.RED)) }) { data ->
            accounts = data.optJSONArray("accounts").objects(); rotation = data.optJSONObject("rotation") ?: JSONObject()
            list.removeAllViews()
            val enabled = accounts.filter { it.optBoolean("enabled") }
            val available = enabled.count { it.optBoolean("available") }
            val busy = accounts.count { it.str("busyWith").isNotBlank() }
            val kpis = ui.row()
            fun kpi(title: String, value: String, note: String, percent: Double?, color: Int) = ui.card(C.CARD, C.LINE, 16, 12).apply {
                addView(ui.caption(title)); addView(ui.text(value, 21f, bold = true), ui.lp(top = 4))
                addView(ui.progress(percent, color), ui.lp(MATCH, dp(5), top = 8)); addView(ui.text(note, 10.5f, C.TX3).apply { maxLines = 1 }, ui.lp(top = 6))
            }
            kpis.addView(kpi("Contas", "$available/${enabled.size}", "disponíveis", if (enabled.isEmpty()) 0.0 else available * 100.0 / enabled.size, C.GREEN), ui.lp(0, WRAP, 1f, end = 8))
            kpis.addView(kpi("Em uso", "$busy", if (busy == 0) "nenhuma execução" else "executando agora", if (enabled.isEmpty()) 0.0 else busy * 100.0 / enabled.size, C.LAV), ui.lp(0, WRAP, 1f, end = 8))
            kpis.addView(kpi("Troca", "${rotation.optInt("switchAtPercent", 90)}%", "limite de uso", rotation.optInt("switchAtPercent", 90).toDouble(), C.AMBER), ui.lp(0, WRAP, 1f))
            list.addView(kpis, ui.lp(bottom = 16))
            val head = ui.row()
            head.addView(ui.text("Contas e fila", 14.5f, bold = true), ui.lp(0, WRAP, 1f))
            head.addView(ui.text("use ↑↓ para reordenar", 11.5f, C.TX3))
            list.addView(head, ui.lp(bottom = 8))
            val order = rotation.optJSONArray("order").strings().ifEmpty { accounts.map { it.str("id") } }
            val ordered = order.mapNotNull { id -> accounts.firstOrNull { it.str("id") == id } } + accounts.filter { it.str("id") !in order }
            ordered.forEachIndexed { index, acc -> list.addView(accountCard(acc, index, ordered.map { it.str("id") }), ui.lp(bottom = 8)) }
            val rules = ui.card(C.CARD, C.LINE, 16, 0)
            fun ruleRow(title: String, note: String, value: Boolean, key: String) = ui.row().apply {
                setPadding(dp(14), dp(12), dp(12), dp(12))
                val t = ui.column(); t.addView(ui.text(title, 13.5f)); t.addView(ui.text(note, 11.5f, C.TX3)); addView(t, ui.lp(0, WRAP, 1f))
                addView(Switch(this@MainActivity).apply {
                    isChecked = value
                    setOnCheckedChangeListener { _, on -> request({ api.call("/api/accounts/rotation", obj(key to on)) }) { r -> this@MainActivity.rotation = r.optJSONObject("rotation") ?: this@MainActivity.rotation } }
                })
            }
            rules.addView(ruleRow("Continuar em outra conta", "Quando o limite chega, segue na próxima da fila", rotation.optBoolean("autoContinue", true), "autoContinue"))
            rules.addView(View(this).apply { setBackgroundColor(C.LINE) }, ui.lp(MATCH, 1, start = 12, end = 12))
            rules.addView(ruleRow("Troca antecipada", "Passa a vez antes de estourar o limite", rotation.optBoolean("proactiveHandoff", false), "proactiveHandoff"))
            list.addView(ui.text("Regras de troca", 14.5f, bold = true), ui.lp(top = 8, bottom = 8))
            list.addView(rules)
            val providers = data.optJSONArray("providers").objects()
            list.addView(ui.action("+ Conectar nova conta") { connectAccountSheet(providers) }.apply { background = ui.shape(Color.TRANSPARENT, 14, 1, C.LINE2) }, ui.lp(MATCH, dp(46), top = 14))
            list.addView(notificationsCard(), ui.lp(top = 14))
            list.addView(ui.text("Codex Harness ${versionName()} · Android", 11.5f, C.TX3).apply { gravity = Gravity.CENTER }, ui.lp(top = 16))
        }
    }

    private fun bytesLabel(bytes: Double): String {
        if (!bytes.isFinite() || bytes < 0) return "—"
        var n = bytes; var i = 0
        val units = arrayOf("B", "KiB", "MiB", "GiB", "TiB")
        while (n >= 1024 && i < units.lastIndex) { n /= 1024; i++ }
        return if (i == 0) "${n.toLong()} B" else "${String.format(Locale("pt", "BR"), "%.1f", n)} ${units[i]}"
    }

    private fun serverHealthSheet() {
        ui.sheet("Saúde da VPS") { body, dialog ->
            val controls = ui.row()
            val updated = ui.text("Lendo métricas…", 11.5f, C.TX3)
            controls.addView(updated, ui.lp(0, WRAP, 1f))
            val refresh = ui.action("Atualizar") {}
            controls.addView(refresh, ui.lp(WRAP, dp(40)))
            body.addView(controls, ui.lp(bottom = 10))
            val content = ui.column(); body.addView(content)
            var loading = false
            lateinit var load: (Boolean) -> Unit
            val pollHealth = object : Runnable {
                override fun run() {
                    if (!dialog.isShowing) return
                    load(false)
                    clock.postDelayed(this, 60_000)
                }
            }
            fun render(data: JSONObject) {
                content.removeAllViews()
                val host = data.optJSONObject("host")
                val docker = data.optJSONObject("docker")
                if (host == null) { content.addView(ui.text("Métricas do servidor indisponíveis.", 13f, C.RED)); return }
                val cpu = host.optJSONObject("cpu") ?: JSONObject()
                val memory = host.optJSONObject("memory") ?: JSONObject()
                val disk = host.optJSONObject("disk")
                fun metric(name: String, value: String, detail: String, percent: Double?) {
                    val card = ui.card(C.CARD, C.LINE, 14, 11)
                    val head = ui.row(); head.addView(ui.text(name, 13f, C.TX2), ui.lp(0, WRAP, 1f)); head.addView(ui.text(value, 13f, C.TX, bold = true)); card.addView(head)
                    if (percent != null && percent.isFinite()) card.addView(ui.progress(percent, if (percent >= 90) C.RED else if (percent >= 75) C.AMBER else C.LAV), ui.lp(MATCH, dp(5), top = 8))
                    card.addView(ui.text(detail, 11.5f, C.TX3), ui.lp(top = 6)); content.addView(card, ui.lp(bottom = 7))
                }
                val cpuPct = cpu.optDouble("percent", Double.NaN)
                metric("CPU", if (cpuPct.isFinite()) "${String.format(Locale("pt", "BR"), "%.1f", cpuPct)}%" else "—", "${cpu.optInt("cores")} vCPU · amostra de uso", cpuPct)
                val total = memory.optDouble("totalBytes", 0.0); val used = memory.optDouble("usedBytes", 0.0)
                metric("Memória", "${bytesLabel(memory.optDouble("availableBytes", Double.NaN))} disponíveis", "${bytesLabel(used)} usados de ${bytesLabel(total)}", if (total > 0) 100.0 * used / total else null)
                if (disk != null) metric("Disco raiz", "${bytesLabel(disk.optDouble("availableBytes", Double.NaN))} livres", "${bytesLabel(disk.optDouble("usedBytes", Double.NaN))} usados de ${bytesLabel(disk.optDouble("totalBytes", Double.NaN))}", disk.optDouble("usedPercent", Double.NaN))
                content.addView(ui.text("Projetos e serviços", 15f, C.TX, bold = true), ui.lp(top = 12, bottom = 8))
                host.optJSONArray("services").objects().forEach { service ->
                    val card = ui.card(C.CARD, C.LINE, 14, 11)
                    card.addView(ui.text(service.str("name"), 13.5f, C.TX, bold = true))
                    card.addView(ui.text("${service.str("status")} · CPU ${String.format(Locale("pt", "BR"), "%.1f", service.optDouble("cpuPercent", 0.0))}% · RAM ${bytesLabel(service.optDouble("memoryBytes", Double.NaN))}", 11.5f, C.TX3), ui.lp(top = 4)); content.addView(card, ui.lp(bottom = 7))
                }
                if (docker?.optBoolean("available") != true) content.addView(ui.text(docker?.str("error")?.ifBlank { null } ?: "Docker indisponível.", 13f, C.RED))
                else {
                    content.addView(ui.text("${docker.optInt("runningCount")} containers ativos · ${docker.optInt("stoppedCount")} parados", 12f, C.TX2), ui.lp(bottom = 8))
                    val containers = docker.optJSONArray("containers").objects()
                    val volumes = data.optJSONArray("dockerVolumes").objects()
                    docker.optJSONArray("projects").objects().forEach { project ->
                        val name = project.str("name"); val card = ui.card(C.CARD, C.LINE, 14, 11)
                        val state = if (project.optBoolean("unhealthy")) "Com falha" else if (project.optInt("stopped") > 0) "${project.optInt("running")}/${project.optInt("containers")} ativos" else "Em execução"
                        card.addView(ui.text(name, 14f, C.TX, bold = true))
                        card.addView(ui.text("${project.optInt("containers")} containers · $state · CPU ${String.format(Locale("pt", "BR"), "%.1f", project.optDouble("cpuPercent", 0.0))}%", 11.5f, C.TX2), ui.lp(top = 4))
                        card.addView(ui.text("RAM ${bytesLabel(project.optDouble("memoryBytes", Double.NaN))} · disco ${bytesLabel(project.optDouble("storageBytes", Double.NaN))}  ▾", 11.5f, C.TX3), ui.lp(top = 4))
                        val details = ui.column().apply { visibility = View.GONE }
                        containers.filter { it.str("project") == name }.forEach { c ->
                            val stateText = if (c.optBoolean("running")) "CPU ${String.format(Locale("pt", "BR"), "%.1f", c.optDouble("cpuPercent", 0.0))}% · RAM ${bytesLabel(c.optDouble("memoryBytes", Double.NaN))}" else c.str("status")
                            details.addView(ui.text("${c.str("name")} · $stateText · disco ${bytesLabel(c.optDouble("storageBytes", Double.NaN))}", 11.5f, C.TX2), ui.lp(top = 7))
                        }
                        if (project.str("sourcePath").isNotBlank()) details.addView(ui.text("Código: ${project.str("sourcePath")} · ${bytesLabel(project.optDouble("sourceBytes", Double.NaN))}", 11.5f, C.TX3), ui.lp(top = 7))
                        volumes.filter { it.str("project") == name }.forEach { v -> details.addView(ui.text("Volume: ${v.str("name")} · ${v.str("size")}", 11.5f, C.TX3), ui.lp(top = 6)) }
                        card.addView(details); card.setOnClickListener { details.visibility = if (details.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
                        content.addView(card, ui.lp(bottom = 7))
                    }
                }
                content.addView(ui.text("Armazenamento Docker", 15f, C.TX, bold = true), ui.lp(top = 12, bottom = 8))
                val names = mapOf("Images" to "Imagens", "Containers" to "Containers", "Local Volumes" to "Volumes", "Build Cache" to "Cache de build")
                val storage = data.optJSONArray("dockerStorage").objects()
                if (storage.isEmpty()) content.addView(ui.text("Resumo indisponível.", 12f, C.TX3))
                storage.forEach { item ->
                    val reclaimable = item.str("reclaimable").takeIf { it.isNotBlank() }?.let { " · $it reclamável" }.orEmpty()
                    content.addView(ui.text("${names[item.str("type")] ?: item.str("type")}: ${item.str("size")}$reclaimable", 12.5f, C.TX2), ui.lp(bottom = 5))
                }
                val allVolumes = data.optJSONArray("dockerVolumes").objects()
                val locations = data.optJSONArray("storageLocations").objects()
                val directories = data.optJSONArray("projectDirectories").objects()
                val storageDetails = ui.column().apply { visibility = View.GONE }
                if (allVolumes.isNotEmpty()) {
                    storageDetails.addView(ui.text("Volumes", 12.5f, C.TX, bold = true), ui.lp(top = 8, bottom = 4))
                    allVolumes.forEach { v -> storageDetails.addView(ui.text("${v.str("name")} · ${v.str("size")} · ${v.str("project").ifBlank { "sem projeto atribuído" }}", 11.5f, C.TX2), ui.lp(bottom = 5)) }
                }
                if (locations.isNotEmpty() || directories.isNotEmpty()) {
                    storageDetails.addView(ui.text("Pastas principais", 12.5f, C.TX, bold = true), ui.lp(top = 8, bottom = 4))
                    locations.forEach { location -> storageDetails.addView(ui.text("${location.str("name")} · ${location.str("path")} · ${bytesLabel(location.optDouble("bytes", Double.NaN))}", 11.5f, C.TX2), ui.lp(bottom = 5)) }
                    directories.forEach { location -> storageDetails.addView(ui.text("Código · ${location.str("project")} · ${location.str("path")} · ${bytesLabel(location.optDouble("bytes", Double.NaN))}", 11.5f, C.TX2), ui.lp(bottom = 5)) }
                }
                content.addView(ui.action("Volumes e pastas  ▾") { storageDetails.visibility = if (storageDetails.visibility == View.VISIBLE) View.GONE else View.VISIBLE }, ui.lp(MATCH, dp(42), top = 8))
                content.addView(storageDetails)
                content.addView(ui.text("CPU é uma amostra. Limites configurados não são recursos reservados. Os totais de pastas e volumes podem se sobrepor.", 11f, C.TX3), ui.lp(top = 10))
                val checked = runCatching { java.time.Instant.parse(data.str("checkedAt")).epochSecond.toDouble() }.getOrNull()
                updated.text = if (checked != null) "Atualizado ${clockTime(checked)} · São Paulo" else "Leitura atualizada"
            }
            load = { force ->
                if (!loading) {
                    loading = true; refresh.isEnabled = false
                    request({ api.call("/api/server-health" + if (force) "?refresh=true" else "") }, onError = { loading = false; refresh.isEnabled = true; updated.text = "Atualização indisponível"; if (dialog.isShowing) ui.toast(it) }, scoped = false) { data ->
                        loading = false; refresh.isEnabled = true
                        if (dialog.isShowing) render(data)
                    }
                }
            }
            refresh.setOnClickListener { load(true) }
            dialog.setOnDismissListener { clock.removeCallbacks(pollHealth) }
            clock.post { if (dialog.isShowing) { load(false); clock.postDelayed(pollHealth, 60_000) } }
        }
    }

    private fun accountCard(acc: JSONObject, index: Int, order: List<String>): View {
        val id = acc.str("id")
        val inUse = acc.str("busyWith").isNotBlank()
        val card = ui.card(if (inUse) 0xff1c1a1a.toInt() else C.CARD, if (inUse) 0xff4a3427.toInt() else C.LINE, 16, 12)
        val head = ui.row()
        val color = providerColor(acc.str("provider"))
        head.addView(ui.text("${index + 1}", 12f, color, bold = true).apply { gravity = Gravity.CENTER; background = ui.shape((color and 0x00ffffff) or 0x33000000, 8) }, ui.lp(dp(26), dp(26), end = 10))
        val names = ui.column()
        val title = ui.row(); title.addView(ui.text(acc.str("label"), 14f, bold = true))
        if (inUse) title.addView(ui.statusPill("warn", "EM USO"), ui.lp(WRAP, WRAP, start = 6))
        if (id == accountId) title.addView(ui.statusPill("info", "NO CHAT"), ui.lp(WRAP, WRAP, start = 6))
        names.addView(title)
        names.addView(ui.text(listOf(acc.str("providerLabel"), acc.str("model"), effortName(acc.str("effort"))).filter { it.isNotBlank() }.joinToString(" · "), 11f, C.TX3).apply { maxLines = 1 })
        head.addView(names, ui.lp(0, WRAP, 1f))
        head.addView(ui.text("↑", 16f, if (index > 0) C.TX2 else C.LINE2).apply { setPadding(dp(8), dp(2), dp(8), dp(2)); if (index > 0) setOnClickListener { reorder(order, index, -1) }; contentDescription = "Subir na fila" })
        head.addView(ui.text("↓", 16f, if (index < order.lastIndex) C.TX2 else C.LINE2).apply { setPadding(dp(8), dp(2), dp(4), dp(2)); if (index < order.lastIndex) setOnClickListener { reorder(order, index, 1) }; contentDescription = "Descer na fila" })
        card.addView(head)
        val percent = if (acc.isNull("percent")) null else acc.optDouble("percent")
        val windows = usageWindowsView(acc)
        if (windows != null) card.addView(windows, ui.lp(top = 10))
        else if (percent != null) card.addView(ui.progress(percent, if (percent >= rotation.optInt("switchAtPercent", 90)) C.AMBER else C.LAV), ui.lp(MATCH, dp(5), top = 10))
        val status = ui.row()
        val ok = acc.optBoolean("available")
        status.addView(ui.dot(if (!acc.optBoolean("enabled")) C.TX3 else if (ok) C.GREEN else C.RED, 7))
        status.addView(ui.text(if (!acc.optBoolean("enabled")) "Desativada" else if (ok) "Disponível" else acc.str("unavailableReason").ifBlank { "Indisponível" }, 11.5f, C.TX2), ui.lp(0, WRAP, 1f, start = 6))
        status.addView(ui.text(if (windows != null) "" else if (percent != null) "${percent.toInt()}% usado" else "uso não informado", 11f, C.TX3))
        card.addView(status, ui.lp(top = 8))
        card.setOnClickListener { accountSheet(acc) }
        return card
    }

    private val usageNames = mapOf("five_hour" to "5 horas", "seven_day" to "Semana", "seven_day_opus" to "Semana · Opus", "seven_day_sonnet" to "Semana · Sonnet", "one_day" to "Dia", "thirty_day" to "30 dias")
    private fun usageName(key: String): String {
        val scope = key.substringBefore(':', "")
        val base = key.substringAfter(':')
        val name = usageNames[base] ?: Regex("^(\\d+)_min$").find(base)?.let { m -> val min = m.groupValues[1].toInt(); if (min % 60 == 0) "${min / 60} h" else "$min min" } ?: base.replace('_', ' ')
        return if (scope.isNotEmpty()) "$name · $scope" else name
    }
    private fun compactNumber(n: Long) = when { n >= 1_000_000 -> "%.1f mi".format(n / 1_000_000.0); n >= 1_000 -> "${n / 1000} mil"; else -> "$n" }

    /** "renova às 18:14 · em 2 h 05 min" or "renova sáb 21:58", always in São Paulo time. */
    private fun resetLabel(seconds: Long): String {
        if (seconds <= 0) return ""
        val ms = seconds * 1000
        val left = ms - System.currentTimeMillis()
        if (left <= 0) return "renovando"
        val zone = TimeZone.getTimeZone("America/Sao_Paulo")
        val time = SimpleDateFormat("HH:mm", Locale("pt", "BR")).apply { timeZone = zone }.format(Date(ms))
        return if (left < 24 * 3600_000L) "renova às $time · em ${duration(left).replace(Regex(" \\d+ s$"), "")}"
        else "renova ${SimpleDateFormat("EEE", Locale("pt", "BR")).apply { timeZone = zone }.format(Date(ms)).trimEnd('.')} $time"
    }

    /** One row per usage window (Codex 5 h + semana, Claude 5 h + semana…), same look for every provider. */
    private fun usageWindowsView(acc: JSONObject, detailed: Boolean = false): View? {
        val windows = acc.optJSONArray("usageWindows").objects().filter { it.has("percent") && !it.isNull("percent") }
        if (windows.isEmpty()) return null
        val order = listOf("five_hour", "one_day", "seven_day", "seven_day_opus", "seven_day_sonnet", "thirty_day")
        val box = ui.column()
        windows.sortedBy { order.indexOf(it.str("window").substringAfter(':')).let { i -> if (i < 0) 99 else i } }.forEachIndexed { index, w ->
            val percent = w.optDouble("percent")
            val color = when { percent >= rotation.optInt("switchAtPercent", 90) -> C.AMBER; percent >= 100 -> C.RED; else -> C.LAV }
            val line = ui.row()
            line.addView(ui.text(usageName(w.str("window")), if (detailed) 12.5f else 11.5f, C.TX2), ui.lp(0, WRAP, 1f))
            line.addView(ui.text("${if (percent % 1.0 == 0.0) percent.toInt().toString() else "%.1f".format(percent)}%", if (detailed) 13f else 12f, if (percent >= rotation.optInt("switchAtPercent", 90)) C.AMBER else C.TX, bold = true))
            box.addView(line, ui.lp(top = if (index > 0) 8 else 0))
            box.addView(ui.progress(percent, color), ui.lp(MATCH, dp(5), top = 4))
            val reset = resetLabel(w.optLong("resetsAt"))
            if (reset.isNotEmpty()) box.addView(ui.text(reset, 10.5f, C.TX3), ui.lp(top = 3))
        }
        return box
    }

    private fun reorder(order: List<String>, index: Int, delta: Int) {
        val list = order.toMutableList()
        Collections.swap(list, index, index + delta)
        request({ api.call("/api/accounts/rotation", obj("order" to JSONArray(list))) }) { show(TAB_OVERVIEW) }
    }

    private fun accountSheet(acc: JSONObject) = ui.sheet(acc.str("label")) { body, dialog ->
        body.addView(ui.text(listOf(acc.str("providerLabel"), acc.str("model"), effortName(acc.str("effort"))).filter { it.isNotBlank() }.joinToString(" · "), 12.5f, C.TX3), ui.lp(bottom = 12))
        val kpis = ui.row()
        fun small(title: String, value: String) = ui.card(C.CARD, C.LINE, 14, 10).apply { addView(ui.caption(title)); addView(ui.text(value, 17f, bold = true), ui.lp(top = 3)) }
        kpis.addView(small("Etapas", "${acc.optInt("segments")}"), ui.lp(0, WRAP, 1f, end = 6))
        kpis.addView(small("Uso", if (acc.isNull("percent")) "n/d" else "${acc.optDouble("percent").toInt()}%"), ui.lp(0, WRAP, 1f, end = 6))
        kpis.addView(small("Último uso", if (acc.optLong("lastUsedAt") > 0) ago(acc.optLong("lastUsedAt")) else "—"), ui.lp(0, WRAP, 1f))
        body.addView(kpis, ui.lp(bottom = 12))
        usageWindowsView(acc, detailed = true)?.let { body.addView(it, ui.lp(bottom = 10)) }
        acc.optJSONObject("reportedUsage")?.takeIf { it.optLong("totalTokens") > 0 }?.let { u ->
            body.addView(ui.text("Tokens registrados pelo harness: ${compactNumber(u.optLong("totalTokens"))} (entrada ${compactNumber(u.optLong("inputTokens"))} · saída ${compactNumber(u.optLong("outputTokens"))}) em ${u.optInt("runs")} execuç${if (u.optInt("runs") == 1) "ão" else "ões"}", 11.5f, C.TX3), ui.lp(bottom = 10))
        }
        if (acc.str("provider") == "claude-code") {
            body.addView(ui.caption("Acesso do agente"), ui.lp(top = 6, bottom = 8))
            val mode = acc.str("permissionMode")
            fun option(title: String, note: String, value: String) = ui.card(if (mode == value) C.SELECT else C.CARD, if (mode == value) C.SELECT_LINE else C.LINE, 15, 12).apply {
                addView(ui.text(title, 13.5f, bold = true)); addView(ui.text(note, 11.5f, C.TX3), ui.lp(top = 2))
                setOnClickListener {
                    if (mode == value) return@setOnClickListener
                    request({ api.call("/api/accounts/${enc(acc.str("id"))}/access", obj("mode" to value)) }) { dialog.dismiss(); show(TAB_OVERVIEW); ui.toast("Acesso atualizado.") }
                }
            }
            body.addView(option("Acesso completo", "Libera as ferramentas que a CLI oferece, sem pedir aprovação", "bypassPermissions"), ui.lp(bottom = 8))
            body.addView(option("Editar com autorização", "Edita arquivos; comandos sensíveis pedem aprovação (bloqueados em headless)", "acceptEdits"), ui.lp(bottom = 8))
            body.addView(ui.text("Vale para a conta inteira. Em execução sem tela, pedidos de aprovação são bloqueados e registrados nos erros da conversa.", 11.5f, C.TX3), ui.lp(bottom = 8))
        }
        val actions = ui.row()
        body.addView(ui.action(if (acc.optBoolean("loggedIn")) "Reconectar conta  ›" else "Conectar conta  ›") { dialog.dismiss(); openConnect(acc.str("id")) }, ui.lp(MATCH, dp(44), top = 4, bottom = 4))
        actions.addView(ui.action("Verificar status") { request({ api.call("/api/accounts/${enc(acc.str("id"))}/check", JSONObject()) }) { dialog.dismiss(); show(TAB_OVERVIEW) } }, ui.lp(0, dp(44), 1f, end = 8))
        actions.addView(ui.action("Usar no chat", primary = true) { accountId = acc.str("id"); model = ""; effort = ""; saveSelection(); dialog.dismiss(); ui.toast("${acc.str("label")} responde as próximas mensagens.") }, ui.lp(0, dp(44), 1f))
        body.addView(actions, ui.lp(top = 8))
    }

    private fun versionName(): String = runCatching { packageManager.getPackageInfo(packageName, 0).versionName ?: "" }.getOrDefault("")

    private fun appMenu() {
        AlertDialog.Builder(this).setTitle("Codex Harness ${versionName()}").setItems(arrayOf("Verificar atualizações", "Abrir Web Harness", "Sair da conta")) { _, i ->
            when (i) { 0 -> checkUpdate(manual = true); 1 -> openLink("$BASE/"); 2 -> logout() }
        }.show()
    }

    // ───────────────────────── Notifications ─────────────────────────

    private fun notificationsCard(): View {
        val card = ui.card(C.CARD, C.LINE, 16, 0)
        val line = ui.row().apply { setPadding(dp(14), dp(12), dp(12), dp(12)) }
        val texts = ui.column()
        texts.addView(ui.text("Notificações", 13.5f))
        texts.addView(ui.text("Avisa quando uma resposta termina, uma aprovação espera você ou uma execução contínua acaba. Mantém uma conexão leve com o servidor e um aviso discreto fixo.", 11.5f, C.TX3))
        line.addView(texts, ui.lp(0, WRAP, 1f, end = 8))
        line.addView(Switch(this).apply {
            isChecked = NotifyService.enabled(this@MainActivity)
            setOnCheckedChangeListener { _, on -> setNotifications(on) }
        })
        card.addView(line)
        return card
    }

    private fun setNotifications(on: Boolean) {
        prefs.edit().putBoolean("notifications", on).apply()
        if (!on) { NotifyService.stop(this); ui.toast("Notificações desligadas."); return }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), ASK_NOTIFY); return
        }
        runCatching { NotifyService.start(this) }.onSuccess { ui.toast("Notificações ligadas.") }.onFailure { ui.toast("Não consegui ligar: ${it.message}") }
    }

    // ───────────────────────── Server terminal ─────────────────────────

    /** The Web Harness shell (30 min sessions on the VPS), with a key row for what the phone keyboard lacks. */
    private fun terminalScreen() = fullscreen { frame, dialog ->
        var sessionId = ""
        var seq = -1
        var polling = true
        val column = ui.column()
        val head = ui.row().apply { setPadding(dp(16), dp(12), dp(56), dp(8)) }
        val titles = ui.column()
        titles.addView(ui.text("Terminal do servidor", 15f, bold = true))
        val status = ui.text("Conectando…", 11.5f, C.TX3)
        titles.addView(status)
        head.addView(titles, ui.lp(0, WRAP, 1f))
        lateinit var startButton: TextView
        column.addView(head)
        val output = ui.text("", 12f, 0xffd5dae5.toInt(), mono = true).apply { setTextIsSelectable(true); setPadding(dp(12), dp(8), dp(12), dp(12)) }
        val outScroll = ScrollView(this).apply { setBackgroundColor(0xff07080a.toInt()); addView(output) }
        column.addView(outScroll, ui.lp(MATCH, 0, 1f))
        fun send(data: String) {
            if (sessionId.isEmpty()) return
            val id = sessionId
            worker.execute { runCatching { api.call("/api/server-terminal/${enc(id)}/input", obj("data" to data)) }.onFailure { runOnUiThread { ui.toast(it.message ?: "Falha ao enviar.") } } }
        }
        val keys = ui.row().apply { setPadding(dp(8), dp(6), dp(8), dp(4)) }
        listOf("Ctrl+C" to "\u0003", "Tab" to "\t", "Esc" to "\u001b", "↑" to "\u001b[A", "↓" to "\u001b[B", "←" to "\u001b[D", "→" to "\u001b[C", "Ctrl+D" to "\u0004", "Ctrl+L" to "\u000c", "Ctrl+Z" to "\u001a", "|" to "|", "~" to "~", "/" to "/", "-" to "-").forEach { (label, data) ->
            keys.addView(ui.text(label, 12.5f, C.TX).apply { background = ui.shape(C.CARD2, 9, 1, C.LINE2); setPadding(dp(11), dp(8), dp(11), dp(8)); setOnClickListener { send(data) } }, ui.lp(WRAP, WRAP, end = 6))
        }
        column.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(keys) })
        val inputRow = ui.row().apply { setPadding(dp(8), dp(4), dp(8), dp(10)) }
        val input = ui.field("Comando…").apply {
            typeface = android.graphics.Typeface.MONOSPACE
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            imeOptions = EditorInfo.IME_ACTION_SEND
        }
        fun submitLine() { val line = input.text.toString(); input.text.clear(); send(line + "\r") }
        input.setOnEditorActionListener { _, _, _ -> submitLine(); true }
        inputRow.addView(input, ui.lp(0, WRAP, 1f, end = 8))
        inputRow.addView(ui.action("Enviar", primary = true) { submitLine() }, ui.lp(WRAP, dp(44)))
        column.addView(inputRow)
        frame.addView(column, FrameLayout.LayoutParams(MATCH, MATCH))

        fun render(session: JSONObject?) {
            val running = session?.str("status") == "running"
            sessionId = if (running) session!!.str("id") else sessionId
            status.text = when {
                session == null -> "Sem sessão aberta"
                running -> "Ativa · ${session.str("cwd")} · encerra sozinha após 30 min"
                else -> "Encerrada" + session.str("detail").takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()
            }
            startButton.text = if (running) "Encerrar" else "Nova sessão"
            if (session != null && session.optInt("outputSeq") != seq) {
                seq = session.optInt("outputSeq")
                val nearEnd = output.height - (outScroll.scrollY + outScroll.height) < dp(80)
                output.text = cleanTerminal(session.str("output").takeLast(60_000))
                if (nearEnd || seq <= 1) outScroll.post { outScroll.fullScroll(View.FOCUS_DOWN) }
            }
        }
        fun start() {
            val charWidth = android.graphics.Paint().apply { typeface = android.graphics.Typeface.MONOSPACE; textSize = 12f * resources.displayMetrics.scaledDensity }.measureText("M")
            val cols = ((resources.displayMetrics.widthPixels - dp(24)) / charWidth).toInt().coerceIn(40, 160)
            status.text = "Abrindo sessão…"
            worker.execute {
                val r = runCatching { api.call("/api/server-terminal", obj("cols" to cols, "rows" to 30)).optJSONObject("session") }
                runOnUiThread { r.onSuccess { seq = -1; render(it) }.onFailure { status.text = it.message ?: "Falha ao abrir." } }
            }
        }
        startButton = ui.action("Nova sessão") {
            if (startButton.text == "Encerrar" && sessionId.isNotEmpty()) {
                val id = sessionId
                worker.execute { val r = runCatching { api.call("/api/server-terminal/${enc(id)}", method = "DELETE").optJSONObject("session") }; runOnUiThread { r.onSuccess { render(it) } } }
            } else start()
        }
        head.addView(startButton, ui.lp(WRAP, dp(38)))
        val loop = object : Runnable {
            override fun run() {
                if (!polling) return
                worker.execute {
                    val r = runCatching { if (sessionId.isEmpty()) api.call("/api/server-terminal").optJSONObject("session") else api.call("/api/server-terminal/${enc(sessionId)}").optJSONObject("session") }
                    runOnUiThread { if (polling) { r.onSuccess { render(it) }; clock.postDelayed(this, if (sessionId.isEmpty()) 2500 else 700) } }
                }
            }
        }
        dialog.setOnDismissListener { polling = false }
        worker.execute {
            val r = runCatching { api.call("/api/server-terminal").optJSONObject("session") }
            runOnUiThread {
                r.onSuccess { existing -> if (existing?.str("status") == "running") render(existing) else start() }.onFailure { status.text = it.message ?: "Falha ao conectar." }
                clock.postDelayed(loop, 700)
            }
        }
    }

    // ───────────────────────── Connect accounts ─────────────────────────

    private fun connectAccountSheet(providers: List<JSONObject>) = ui.sheet("Conectar nova conta") { body, dialog ->
        body.addView(ui.text("Escolha o provedor. O login roda num terminal na VPS; o app mostra os links e códigos para você concluir pelo celular.", 12.5f, C.TX3), ui.lp(bottom = 12))
        val names = mapOf("codex" to "Codex", "claude-code" to "Claude", "antigravity" to "Antigravity", "gemini-cli" to "Gemini")
        val bases = mapOf("codex" to "codex", "claude-code" to "claude", "antigravity" to "google", "gemini-cli" to "gemini")
        providers.forEach { provider ->
            val pid = provider.str("id")
            menuOption(body, names[pid] ?: provider.str("label"), provider.str("label")) {
                val base = bases[pid] ?: pid
                val id = (1..99).map { "$base-$it" }.firstOrNull { candidate -> accounts.none { it.str("id") == candidate } } ?: "$base-${System.currentTimeMillis() % 1000}"
                val label = "${names[pid] ?: provider.str("label")} ${id.substringAfterLast('-')}"
                request({ api.call("/api/accounts", obj("provider" to pid, "id" to id, "label" to label)) }) { data ->
                    accounts = data.optJSONArray("accounts").objects()
                    dialog.dismiss()
                    openConnect(data.optJSONObject("account")?.str("id") ?: id)
                }
            }
        }
    }

    /** Same flow as the web wizard: CLI check/install, choose a login flow, follow links/codes, type into the login terminal. */
    private fun openConnect(accountId: String) = request({ api.call("/api/accounts/${enc(accountId)}/setup") }) { data ->
        val setup = data.optJSONObject("setup") ?: JSONObject()
        val label = account(accountId)?.str("label") ?: setup.str("providerLabel")
        fullscreen { frame, dialog ->
            var sessionId = ""
            var polling = true
            var flowId = setup.optJSONArray("flows").objects().firstOrNull()?.str("id").orEmpty()
            val list = ui.column().apply { setPadding(dp(16), dp(14), dp(16), dp(30)) }
            frame.addView(ScrollView(this).apply { addView(list) }, FrameLayout.LayoutParams(MATCH, MATCH))
            list.addView(ui.text("Conectar · $label", 17f, bold = true).apply { setPadding(0, 0, dp(44), 0) })
            val installed = setup.str("binPath").isNotBlank()
            val cli = ui.row()
            cli.addView(ui.statusPill(if (installed) "ok" else "warn", if (installed) "CLI instalada" else "CLI não encontrada"))
            if (data.optBoolean("loggedIn")) cli.addView(ui.statusPill("ok", "Conectada"), ui.lp(WRAP, WRAP, start = 6))
            list.addView(cli, ui.lp(top = 10))
            list.addView(ui.text(listOf(setup.str("binPath").ifBlank { setup.str("bin") }, setup.str("version")).filter { it.isNotBlank() }.joinToString(" · "), 11.5f, C.TX3, mono = true), ui.lp(top = 4))
            setup.str("notes").takeIf { it.isNotBlank() }?.let { list.addView(ui.text(it, 12.5f, C.TX2), ui.lp(top = 10)) }
            val flows = setup.optJSONArray("flows").objects()
            val steps = ui.column()
            fun drawSteps() {
                steps.removeAllViews()
                flows.firstOrNull { it.str("id") == flowId }?.optJSONArray("steps").strings().forEachIndexed { i, step ->
                    steps.addView(ui.text("${i + 1}. $step", 12.5f, C.TX2), ui.lp(bottom = 4))
                }
            }
            if (flows.size > 1) {
                list.addView(ui.caption("Forma de login"), ui.lp(top = 14, bottom = 8))
                val box = ui.column()
                fun drawFlows() { box.removeAllViews(); box.addView(ui.flow(flows.map { f -> ui.choice(f.str("label"), f.str("id") == flowId) { flowId = f.str("id"); drawFlows(); drawSteps() } })) }
                drawFlows(); list.addView(box)
            }
            drawSteps(); list.addView(steps, ui.lp(top = 10))

            // Login session panel
            val panel = ui.card(C.PANEL, C.LINE, 14, 12).apply { visibility = View.GONE }
            val sessionStatus = ui.text("", 13f, bold = true)
            val hints = ui.column()
            val out = ui.text("", 11.5f, 0xffd5dae5.toInt(), mono = true).apply { setTextIsSelectable(true) }
            val outBox = ScrollView(this).apply { setBackgroundColor(0xff07080a.toInt()); setPadding(dp(8), dp(6), dp(8), dp(6)); addView(out) }
            panel.addView(sessionStatus)
            panel.addView(hints, ui.lp(top = 8))
            panel.addView(outBox, ui.lp(MATCH, dp(220), top = 8))
            val reply = ui.field("Cole o código ou responda ao terminal").apply { imeOptions = EditorInfo.IME_ACTION_SEND }
            val replyRow = ui.row()
            replyRow.addView(reply, ui.lp(0, WRAP, 1f, end = 8))
            fun sendReply() {
                val text = reply.text.toString(); if (sessionId.isEmpty()) return
                reply.text.clear()
                request({ api.call("/api/login-sessions/${enc(sessionId)}/input", obj("data" to text + "\r")) }) {}
            }
            reply.setOnEditorActionListener { _, _, _ -> sendReply(); true }
            replyRow.addView(ui.action("Enviar", primary = true) { sendReply() }, ui.lp(WRAP, dp(44)))
            panel.addView(replyRow, ui.lp(top = 8))
            val keyRow = ui.row()
            listOf("Enter" to "\r", "↑" to "\u001b[A", "↓" to "\u001b[B", "Esc" to "\u001b", "Ctrl+C" to "\u0003").forEach { (k, v) ->
                keyRow.addView(ui.text(k, 12f, C.TX).apply { background = ui.shape(C.CARD2, 9, 1, C.LINE2); setPadding(dp(10), dp(7), dp(10), dp(7)); setOnClickListener { if (sessionId.isNotEmpty()) request({ api.call("/api/login-sessions/${enc(sessionId)}/input", obj("data" to v)) }) {} } }, ui.lp(WRAP, WRAP, end = 6))
            }
            panel.addView(HorizontalScrollView(this).apply { addView(keyRow) }, ui.lp(top = 6))
            var shownHints = ""
            fun renderSession(session: JSONObject) {
                panel.visibility = View.VISIBLE
                val st = session.str("status")
                sessionStatus.text = when (st) { "running" -> "Conectando… siga os passos abaixo"; "success", "completed" -> "Conta conectada"; "failed" -> "Falhou"; "stopped", "cancelled" -> "Cancelado"; "closed" -> "Terminal encerrado"; else -> st } +
                    session.str("detail").takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()
                sessionStatus.setTextColor(when (st) { "running" -> C.LAV; "failed" -> C.RED; else -> C.GREEN })
                val h = session.optJSONObject("hints")
                val key = h?.toString().orEmpty()
                if (key != shownHints) {
                    shownHints = key; hints.removeAllViews()
                    h?.optJSONArray("links").strings().forEach { link -> hints.addView(ui.action("Abrir link de login  ↗") { openLink(link) }, ui.lp(MATCH, dp(44), bottom = 6)); hints.addView(ui.text(link, 10.5f, C.TX3).apply { maxLines = 2 }, ui.lp(bottom = 8)) }
                    h?.optJSONArray("codes").strings().forEach { code -> hints.addView(ui.text("Código: $code  · toque para copiar", 14f, C.TX, bold = true).apply { background = ui.shape(C.SELECT, 10, 1, C.SELECT_LINE); setPadding(dp(12), dp(10), dp(12), dp(10)); setOnClickListener { copyText(code) } }, ui.lp(bottom = 6)) }
                }
                val near = out.height - (outBox.scrollY + outBox.height) < dp(60)
                out.text = cleanTerminal(session.str("output").takeLast(20_000))
                if (near) outBox.post { outBox.fullScroll(View.FOCUS_DOWN) }
                if (st != "running") { sessionId = ""; loadAccounts() }
            }
            val poll = object : Runnable {
                override fun run() {
                    if (!polling || sessionId.isEmpty()) { if (polling) clock.postDelayed(this, 1500); return }
                    val id = sessionId
                    worker.execute { val r = runCatching { api.call("/api/login-sessions/${enc(id)}").optJSONObject("session") }; runOnUiThread { if (polling) { r.getOrNull()?.let { renderSession(it) }; clock.postDelayed(this, 1000) } } }
                }
            }
            fun begin(kind: String) {
                val go = {
                    request({
                        if (kind == "login" && data.optBoolean("loggedIn")) api.call("/api/accounts/${enc(accountId)}/logout", JSONObject())
                        api.call("/api/accounts/${enc(accountId)}/$kind", obj("flowId" to flowId)).optJSONObject("session")
                    }) { session -> if (session != null) { sessionId = session.str("id"); renderSession(session) } }
                }
                if (kind == "login" && data.optBoolean("loggedIn")) AlertDialog.Builder(this).setTitle("Reconectar?").setMessage("Isso apaga o login atual de $label e inicia um novo.").setPositiveButton("Reconectar") { _, _ -> go() }.setNegativeButton("Cancelar", null).show()
                else go()
            }
            if (!installed && setup.str("install").isNotBlank()) list.addView(ui.action("Instalar a CLI na VPS") { begin("install") }, ui.lp(MATCH, dp(46), top = 14))
            if (installed && flows.isNotEmpty()) list.addView(ui.action(if (data.optBoolean("loggedIn")) "Reconectar" else "Iniciar conexão", primary = true) { begin("login") }, ui.lp(MATCH, dp(48), top = 14))
            setup.optJSONObject("secret")?.let { secret ->
                list.addView(ui.caption(secret.str("label")), ui.lp(top = 16, bottom = 6))
                val value = ui.field(secret.str("placeholder")).apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
                list.addView(value)
                list.addView(ui.action("Salvar chave") {
                    val v = value.text.toString().trim(); if (v.isEmpty()) return@action
                    request({ api.call("/api/accounts/${enc(accountId)}/secret", obj("value" to v)) }) { r -> value.text.clear(); accounts = r.optJSONArray("accounts").objects(); ui.toast("Chave salva.") }
                }, ui.lp(MATCH, dp(44), top = 8))
            }
            list.addView(panel, ui.lp(top = 16))
            list.addView(ui.text("O terminal de login fica no servidor. Se o provedor abrir uma página de autorização, conclua no navegador e volte aqui; o status atualiza sozinho.", 11.5f, C.TX3), ui.lp(top = 12))
            dialog.setOnDismissListener {
                polling = false
                if (sessionId.isNotEmpty()) worker.execute { runCatching { api.call("/api/login-sessions/${enc(sessionId)}", method = "DELETE") } }
                if (tab == TAB_OVERVIEW) show(TAB_OVERVIEW)
            }
            clock.postDelayed(poll, 1000)
        }
    }

    // ───────────────────────── Updates ─────────────────────────

    private var updateChecked = false
    private fun checkUpdate(manual: Boolean) {
        worker.execute {
            val result = runCatching { api.call("/android-release.json") }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                result.onFailure { if (manual) ui.toast("Não foi possível verificar atualizações.") }
                result.onSuccess { release ->
                    val installed = packageManager.getPackageInfo(packageName, 0)
                    @Suppress("DEPRECATION")
                    val versionCode = if (Build.VERSION.SDK_INT >= 28) installed.longVersionCode else installed.versionCode.toLong()
                    if (release.optLong("versionCode") <= versionCode) { if (manual) ui.toast("Você já está na versão mais recente."); return@onSuccess }
                    AlertDialog.Builder(this).setTitle("Atualização disponível")
                        .setMessage("Codex Harness ${release.str("versionName")}\n\n${release.str("notes")}")
                        .setPositiveButton("Atualizar agora") { _, _ -> installUpdate(release) }
                        .setNeutralButton("Página") { _, _ -> openLink("$BASE/android.html") }
                        .setNegativeButton("Depois", null).show()
                }
            }
        }
    }
}

/** Composer that turns pasted files/images (clipboard URIs, keyboard-inserted images) into attachments. */
class PasteAwareEditText(context: android.content.Context, private val onFiles: (List<Uri>) -> Unit) : EditText(context) {
    init {
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            setOnReceiveContentListener(arrayOf("image/*", "application/pdf", "text/plain", "*/*"), android.view.OnReceiveContentListener { view, payload ->
                val clip = payload.clip
                val uris = (0 until clip.itemCount).map { clip.getItemAt(it) }.filter { it.uri != null && it.text.isNullOrEmpty() }.mapNotNull { it.uri }
                if (uris.isNotEmpty()) { view.post { onFiles(uris) }; null } else payload // plain text keeps flowing into the field
            })
        }
    }
    override fun onTextContextMenuItem(id: Int): Boolean {
        if (id == android.R.id.paste || id == android.R.id.pasteAsPlainText) {
            val clip = (context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager).primaryClip
            if (clip != null) {
                val items = (0 until clip.itemCount).map { clip.getItemAt(it) }
                val uris = items.filter { it.uri != null && it.text.isNullOrEmpty() }.mapNotNull { it.uri }
                if (uris.isNotEmpty() && items.none { !it.text.isNullOrEmpty() }) { onFiles(uris); return true }
            }
        }
        return super.onTextContextMenuItem(id)
    }
}
