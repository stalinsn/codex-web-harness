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
    private lateinit var settingsChip: TextView
    private lateinit var composerHint: TextView
    private lateinit var composerRow: LinearLayout
    private lateinit var recordingBar: LinearLayout
    private lateinit var recordingLevel: TextView
    private lateinit var recordingTime: TextView
    private lateinit var attachmentStrip: LinearLayout
    private val attachments = mutableListOf<Attachment>()
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
            if (elapsed >= 180_000) finishRecording(send = true) else clock.postDelayed(this, 120)
        }
    }

    // Lists
    private var archived = false
    private var query = ""
    private var taskFilter = 0

    private val poll = object : Runnable {
        override fun run() {
            when (tab) {
                TAB_CHAT -> if (threadId.isNotEmpty()) { readHistory(silent = true); pollCount++; if (isLocal() || running() || queue.isNotEmpty() || pollCount % 4 == 0) readQueue() }
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
            if (it.optBoolean("authenticated")) shell(if (threadId.isNotEmpty()) TAB_CHAT else TAB_PROJECTS) else login()
        }
    }

    override fun onStart() {
        super.onStart()
        clock.post(poll)
        if (!updateChecked) { updateChecked = true; checkUpdate(manual = false) }
    }
    override fun onStop() { clock.removeCallbacks(poll); super.onStop() }
    override fun onDestroy() { voice.stopQuietly(); updater.release(); worker.shutdownNow(); super.onDestroy() }
    override fun onPause() { if (voice.recording) finishRecording(send = false); super.onPause() }

    @Deprecated("Android back callback")
    override fun onBackPressed() {
        if (tab == TAB_PROJECTS || tab < 0) super.onBackPressed() else show(TAB_PROJECTS)
    }

    private fun <T> request(work: () -> T, onError: (String) -> Unit = { ui.toast(it) }, done: (T) -> Unit) {
        val token = epoch
        worker.execute {
            val result = runCatching(work)
            runOnUiThread {
                if (token != epoch || isFinishing || isDestroyed) return@runOnUiThread
                result.fold(done) { error ->
                    if (error is SessionExpired) login(error.message.orEmpty())
                    else onError(error.message ?: "Falha de conexão.")
                }
            }
        }
    }

    private fun dp(n: Int) = ui.dp(n)
    private fun isLocal() = threadId.startsWith("ext-")
    private fun allTurns() = (older + latest).distinctBy { it.str("id") }
    private fun running() = allTurns().lastOrNull()?.str("status") == "inProgress"
    private fun account(id: String = accountId) = accounts.firstOrNull { it.str("id") == id }
    private fun clockTime(seconds: Double) = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date((seconds * 1000).toLong()))
    private fun duration(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return when { s < 60 -> "$s s"; s < 3600 -> "${s / 60} min ${s % 60} s"; else -> "${s / 3600} h ${(s % 3600) / 60} min" }
    }
    private fun ago(ms: Long): String {
        val s = ((System.currentTimeMillis() - ms) / 1000).coerceAtLeast(0)
        return when { s < 60 -> "agora"; s < 3600 -> "há ${s / 60} min"; s < 86400 -> "há ${s / 3600} h"; else -> "há ${s / 86400} d" }
    }
    private fun saveSelection() = prefs.edit().putString("accountId", accountId).putString("model", model).putString("effort", effort).apply()
    private fun saveThread() = prefs.edit().putString("threadId", threadId).putString("threadTitle", threadTitle).apply()
    private fun loadAccounts(done: () -> Unit = {}) = request({ api.call("/api/accounts") }, onError = {}) {
        accounts = it.optJSONArray("accounts").objects(); rotation = it.optJSONObject("rotation") ?: JSONObject(); done()
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

    private fun openThread(id: String, title: String, cwd: String = "", accountHint: String = "") {
        threadId = id; threadTitle = title; threadCwd = cwd
        older = emptyList(); latest = emptyList(); queue = emptyList(); next = ""; rendered = ""; expanded.clear(); collapsed.clear()
        if (accountHint.isNotEmpty() && account(accountHint) != null) accountId = accountHint
        saveThread()
        show(TAB_CHAT)
    }

    private fun chatTab() {
        val root = page()
        if (threadId.isEmpty() && newCwd.isEmpty() && threadTitle != "Nova conversa") { chatEmpty(root); return }
        val bar = ui.row().apply { setPadding(dp(12), dp(10), dp(12), dp(10)) }
        bar.addView(ui.iconButton(R.drawable.ic_back, "Projetos") { show(TAB_PROJECTS) })
        val titles = ui.column().apply { setPadding(dp(10), 0, dp(6), 0) }
        val projectName = projectFor(threadCwd.ifEmpty { newCwd })
        titles.addView(ui.text("Codex › ${projectName.ifEmpty { "Sem projeto" }}", 11f, C.TX3).apply { maxLines = 1 })
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

        history = ui.column().apply { setPadding(dp(14), dp(10), dp(14), dp(16)) }
        scroll = ScrollView(this).apply { isFillViewport = true; addView(history) }
        root.addView(scroll, ui.lp(MATCH, 0, 1f))

        queueBox = ui.column()
        root.addView(queueBox, ui.lp(start = 10, end = 10))

        // Composer
        val box = ui.column().apply { background = ui.shape(C.PANEL, 22, 1, C.LINE2); setPadding(dp(10), dp(6), dp(10), dp(8)) }
        composerHint = ui.text("", 11f, C.TX3).apply { visibility = View.GONE; setPadding(dp(4), dp(4), 0, 0) }
        box.addView(composerHint)
        composer = EditText(this).apply {
            hint = "Mensagem para o Codex…"; setHintTextColor(C.TX3); setTextColor(C.TX); textSize = 15f; background = null
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            maxLines = 6; setPadding(dp(4), dp(6), dp(4), dp(6))
            setText(prefs.getString("draft:$threadId", ""))
        }
        attachmentStrip = ui.row()
        box.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(attachmentStrip) }, ui.lp(bottom = 2))
        box.addView(composer, ui.lp())
        recordingBar = ui.row().apply { visibility = View.GONE; setPadding(dp(2), dp(4), dp(2), dp(4)) }
        recordingBar.addView(ui.text("■", 14f, Color.WHITE, bold = true).apply {
            gravity = Gravity.CENTER; contentDescription = "Parar e transcrever"
            background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(C.RED) }
            setOnClickListener { finishRecording(send = prefs.getBoolean("voiceAutoSend", false)) }
        }, ui.lp(dp(40), dp(40), end = 10))
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
        tools.addView(steer, ui.lp(WRAP, WRAP, end = 8))
        tools.addView(ui.iconButton(R.drawable.ic_mic, "Gravar áudio", C.TX2, bordered = false) { startRecording() }, ui.lp(dp(40), dp(40), end = 4))
        tools.addView(ImageButton(this).apply {
            setImageResource(R.drawable.ic_send); setColorFilter(C.LAV_DARK); contentDescription = "Enviar"
            background = ui.shape(C.LAV, 13); setOnClickListener { submit() }
        }, ui.lp(dp(42), dp(42)))
        box.addView(tools, ui.lp(top = 2))
        root.addView(box, ui.lp(start = 10, end = 10, top = 6, bottom = 8))
        composer.addTextChangedListener(object : android.text.TextWatcher {
            override fun afterTextChanged(s: android.text.Editable?) {
                prefs.edit().putString("draft:$threadId", s?.toString() ?: "").apply()
                steer.visibility = if (running() && !s.isNullOrBlank() && account(currentAnswerer())?.str("provider") == "codex") View.VISIBLE else View.GONE
            }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })
        updateLive()
        drawAttachments()
        if (threadId.isNotEmpty()) { readHistory(); readQueue() }
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
        val e = effort.ifEmpty { acc?.str("effort").orEmpty() }
        return listOf(acc?.str("label") ?: accountId, m.ifEmpty { "modelo padrão" }, effortName(e)).filter { it.isNotBlank() }.joinToString(" · ")
    }
    private fun effortName(e: String) = mapOf("low" to "Baixo", "medium" to "Médio", "high" to "Alto", "xhigh" to "Máx.", "minimal" to "Mínimo", "max" to "Máx.")[e] ?: e

    private fun updateLive() {
        if (!::liveText.isInitialized || tab != TAB_CHAT) return
        val turn = allTurns().lastOrNull()
        val busy = turn?.str("status") == "inProgress"
        val answerer = account(turn?.optJSONObject("account")?.str("id") ?: accountId) ?: account()
        val who = if (busy) (answerer?.str("label") ?: "Agente") else modelLabel(account())
        val status = if (busy) " · trabalhando há ${duration(((System.currentTimeMillis() / 1000.0) - turn!!.optDouble("startedAt")).toLong() * 1000)}" else " · pronta"
        liveText.text = who + status
        liveDot.background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(if (busy) C.LAV else C.GREEN) }
        stopButton.visibility = if (busy) View.VISIBLE else View.GONE
        settingsChip.text = modelLabel(account())
        composerHint.visibility = if (busy) View.VISIBLE else View.GONE
        composerHint.text = "Em execução · sua próxima mensagem entra na fila"
    }

    private fun readHistory(silent: Boolean = false, before: String = "") {
        if (threadId.isBlank() || historyPending) return
        historyPending = true
        val id = threadId
        request({ api.call("/api/threads/${enc(id)}/history" + if (before.isEmpty()) "" else "?cursor=${enc(before)}") },
            onError = { historyPending = false; if (!silent) ui.toast(it) }) { data ->
            historyPending = false
            if (id != threadId) return@request
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
        scroll.post {
            if (prepend) scroll.scrollTo(0, previousY + history.height - previousHeight)
            else if (atBottom || previousHeight == 0) scroll.fullScroll(View.FOCUS_DOWN)
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
        val steps = items.filter { it.str("type") in TOOL_TYPES || (it.str("type") == "agentMessage" && it !== final && it.str("text").isNotBlank()) }
        if (steps.isNotEmpty() || busy) workCard(turn, steps, busy)
        if (final != null) {
            val acc = turn.optJSONObject("account")
            val box = ui.column()
            box.addView(ui.text(acc?.str("label")?.ifBlank { null } ?: "Codex", 11.5f, providerColor(acc?.str("provider").orEmpty()), bold = true), ui.lp(bottom = 4))
            md.render(final.str("text"), box)
            val ms = turn.optLong("durationMs").takeIf { it > 0 } ?: ((turn.optDouble("completedAt") - turn.optDouble("startedAt")) * 1000).toLong()
            if (ms > 0 && !busy) box.addView(ui.pill("⏱ Trabalhou por ${duration(ms)}"), ui.lp(WRAP, WRAP, top = 2))
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
        val text = content.filter { it.str("type") == "text" }.joinToString("\n") { it.str("text") }
        val attachments = content.count { it.str("type") != "text" }
        val bubble = ui.column().apply { background = ui.shape(C.BLUE, 18, 1, C.BLUE_LINE).apply { cornerRadii = floatArrayOf(dp(18f), dp(18f), dp(18f), dp(18f), dp(6f), dp(6f), dp(18f), dp(18f)) }; setPadding(dp(14), dp(10), dp(14), dp(10)) }
        if (text.isNotBlank()) bubble.addView(ui.text(text.trim(), 15f, 0xffeef3ff.toInt()).apply { setTextIsSelectable(true) })
        if (attachments > 0) bubble.addView(ui.text("📎 $attachments anexo(s)", 12f, 0xffaab6dc.toInt()), ui.lp(top = 4))
        val queuedAt = turn.optDouble("queuedAt", 0.0)
        val startedAt = turn.optDouble("startedAt", 0.0)
        if (queuedAt > 0 && startedAt - queuedAt >= 5) bubble.addView(ui.text("Enviada às ${clockTime(queuedAt)} · esperou ${duration(((startedAt - queuedAt) * 1000).toLong())} na fila", 11.5f, 0xffaab6dc.toInt()).apply { gravity = Gravity.END }, ui.lp(top = 6))
        history.addView(bubble, ui.lp(WRAP, WRAP, top = 6, bottom = 10, start = 40).apply { gravity = Gravity.END })
    }
    private fun dp(f: Float) = f * resources.displayMetrics.density

    /** "Trabalhando" card: every tool call of the turn, collapsible, newest state on top. */
    private fun workCard(turn: JSONObject, steps: List<JSONObject>, busy: Boolean) {
        val id = turn.str("id")
        val open = if (busy) id !in collapsed else id in expanded
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
            if (busy) { if (!collapsed.remove(id)) collapsed += id } else { if (!expanded.remove(id)) expanded += id }
            rendered = ""; drawHistory(false)
        }
        card.addView(head)
        if (open) {
            card.addView(View(this).apply { setBackgroundColor(C.LINE) }, ui.lp(MATCH, 1))
            val list = if (steps.size > 14) steps.takeLast(14) else steps
            if (steps.size > list.size) card.addView(ui.text("+ ${steps.size - list.size} etapas anteriores", 11.5f, C.TX3).apply { setPadding(dp(12), dp(8), dp(12), 0) })
            list.forEachIndexed { index, step -> card.addView(stepRow(step, busy && index == list.lastIndex)) }
            if (busy && steps.isEmpty()) card.addView(ui.text("Preparando…", 12.5f, C.TX3).apply { setPadding(dp(12), dp(10), dp(12), dp(12)) })
        }
        history.addView(card, ui.lp(bottom = 12))
    }

    private fun stepRow(item: JSONObject, current: Boolean): View {
        val type = item.str("type")
        val failed = item.str("status") in setOf("failed", "declined") || (item.has("exitCode") && item.optInt("exitCode", 0) != 0)
        val (title, detail, output) = when (type) {
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
        if (detail.isNotBlank()) texts.addView(ui.text(detail, 11.5f, 0xffc9cfdb.toInt(), mono = type == "commandExecution").apply {
            maxLines = 3; ellipsize = android.text.TextUtils.TruncateAt.END
            if (type == "commandExecution") { background = ui.shape(0xff1d2128.toInt(), 6); setPadding(dp(6), dp(2), dp(6), dp(2)) }
        }, ui.lp(WRAP, WRAP, top = 3))
        val outputText = when (output) { null, JSONObject.NULL -> ""; is JSONObject -> output.toString(2); is JSONArray -> output.toString(2); else -> output.toString() }.take(6000)
        if (outputText.isNotBlank()) {
            val out = ui.text(outputText, 11.5f, C.TX2, mono = true).apply {
                visibility = View.GONE; setTextIsSelectable(true); background = ui.shape(0xff101113.toInt(), 8); setPadding(dp(8), dp(6), dp(8), dp(6))
            }
            texts.addView(out, ui.lp(top = 6))
            box.setOnClickListener { out.visibility = if (out.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
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
        composer.isEnabled = false
        request({ api.call("/api/turn", body) }, onError = { composer.isEnabled = true; ui.toast(it) }) {
            composer.isEnabled = true
            if (composer.text.toString().trim() == text) composer.text.clear()
            attachments.removeAll(sending); drawAttachments()
            val created = it.str("threadId")
            if (created.isNotBlank() && created != threadId) { threadId = created; newCwd = ""; saveThread() }
            if (it.optBoolean("queued")) ui.toast("Mensagem na fila: entra quando a resposta atual terminar.")
            readHistory(); readQueue()
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

    private fun threadMenu() {
        if (threadId.isEmpty()) return
        val items = arrayOf("Renomear", "Arquivar", "Atualizar", "Abrir no Web Harness")
        AlertDialog.Builder(this).setItems(items) { _, i ->
            when (i) {
                0 -> renameThread(threadId, threadTitle) { threadTitle = it; saveThread(); show(TAB_CHAT) }
                1 -> request({ api.call("/api/threads/${enc(threadId)}/archive", JSONObject()) }) { ui.toast("Conversa arquivada."); threadId = ""; threadTitle = ""; saveThread(); show(TAB_PROJECTS) }
                2 -> { rendered = ""; readHistory(); readQueue() }
                3 -> openLink("$BASE/#thread=$threadId")
            }
        }.show()
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
            body.addView(ui.caption("Conta"), ui.lp(top = 6, bottom = 8))
            val usable = accounts.filter { it.optBoolean("enabled") }
            body.addView(ui.flow(usable.map { acc ->
                val label = acc.str("label") + if (!acc.optBoolean("available")) " · ${acc.str("unavailableReason").ifBlank { "indisponível" }}" else ""
                ui.choice(label, acc.str("id") == accountId) { accountId = acc.str("id"); model = ""; effort = ""; saveSelection(); dialog.dismiss(); settingsSheet(); updateLive() }
            }))
            val modelsBox = ui.column()
            body.addView(ui.caption("Modelo"), ui.lp(top = 16, bottom = 8))
            body.addView(modelsBox)
            modelsBox.addView(ui.text("Carregando modelos…", 13f, C.TX3))
            request({ api.call("/api/accounts/${enc(accountId)}/models") }, onError = { modelsBox.removeAllViews(); modelsBox.addView(ui.text("Não consegui listar os modelos: $it", 12.5f, C.TX3)) }) { catalog ->
                modelsBox.removeAllViews()
                val models = catalog.optJSONArray("models").objects()
                val current = model.ifEmpty { account()?.str("model").orEmpty() }
                val chips = mutableListOf<View>(ui.choice("Padrão da conta", model.isEmpty()) { model = ""; effort = ""; saveSelection(); dialog.dismiss(); settingsSheet(); updateLive() })
                models.forEach { m -> chips += ui.choice(m.str("label").ifBlank { m.str("id") }, model.isNotEmpty() && m.str("id") == current) { model = m.str("id"); effort = m.str("defaultEffort"); saveSelection(); dialog.dismiss(); settingsSheet(); updateLive() } }
                modelsBox.addView(ui.flow(chips))
                val selected = models.firstOrNull { it.str("id") == current }
                val efforts = selected?.optJSONArray("efforts").strings().ifEmpty { if (account()?.str("provider") == "codex") listOf("low", "medium", "high", "xhigh") else emptyList() }
                if (efforts.isNotEmpty()) {
                    modelsBox.addView(ui.caption("Esforço"), ui.lp(top = 16, bottom = 8))
                    modelsBox.addView(ui.flow(efforts.map { e -> ui.choice(effortName(e), e == effort.ifEmpty { account()?.str("effort").orEmpty() }) { effort = e; saveSelection(); dialog.dismiss(); settingsSheet(); updateLive() } }))
                }
                catalog.str("note").takeIf { it.isNotBlank() }?.let { modelsBox.addView(ui.text(it, 11.5f, C.TX3), ui.lp(top = 12)) }
            }
            val auto = ui.row().apply { setPadding(0, dp(14), 0, 0) }
            val autoTexts = ui.column(); autoTexts.addView(ui.text("Enviar áudio direto", 13.5f)); autoTexts.addView(ui.text("Desligado: o texto transcrito vai para o campo para você revisar", 11.5f, C.TX3))
            auto.addView(autoTexts, ui.lp(0, WRAP, 1f))
            auto.addView(Switch(this).apply { isChecked = prefs.getBoolean("voiceAutoSend", false); setOnCheckedChangeListener { _, on -> prefs.edit().putBoolean("voiceAutoSend", on).apply() } })
            body.addView(auto)
            body.addView(ui.action("Pronto", primary = true) { dialog.dismiss() }, ui.lp(MATCH, dp(46), top = 18))
        }
    }

    // ───────────────────────── Voice ─────────────────────────

    private fun startRecording() {
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
        composerHint.text = if (on) "Gravando · toque em ■ para transcrever" else "Em execução · sua próxima mensagem entra na fila"
        window.decorView.keepScreenOn = on
    }

    private fun finishRecording(send: Boolean) {
        clock.removeCallbacks(meter)
        val file = voice.stop()
        showRecording(false)
        if (file == null) { ui.toast("Gravação curta demais."); return }
        composerHint.visibility = View.VISIBLE; composerHint.text = "Transcrevendo o áudio…"
        request({
            val data = android.util.Base64.encodeToString(file.readBytes(), android.util.Base64.NO_WRAP)
            file.delete()
            val job = api.call("/api/voice/transcriptions", obj("mime" to "audio/mp4", "data" to data))
            val id = job.str("id")
            var result = job
            val deadline = System.currentTimeMillis() + 180_000
            while (result.str("status") == "processing" && System.currentTimeMillis() < deadline) {
                Thread.sleep(900)
                result = api.call("/api/voice/transcriptions/${enc(id)}")
            }
            result
        }, onError = { composerHint.visibility = View.GONE; ui.toast("Transcrição falhou: $it") }) { result ->
            composerHint.visibility = if (running()) View.VISIBLE else View.GONE
            composerHint.text = "Em execução · sua próxima mensagem entra na fila"
            val text = result.str("text").trim()
            when {
                result.str("status") == "failed" -> ui.toast("Transcrição falhou: ${result.str("error")}")
                text.isEmpty() -> ui.toast("Não entendi o áudio. Tente de novo mais perto do microfone.")
                else -> {
                    val current = composer.text.toString().trim()
                    composer.setText(if (current.isEmpty()) text else "$current $text")
                    composer.setSelection(composer.text.length)
                    if (send) submit()
                }
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == ASK_MIC) {
            if (grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED) startRecording()
            else ui.toast("Sem acesso ao microfone. Libere em Configurações › Apps › Codex Harness.")
        }
    }

    // ───────────────────────── Attachments ─────────────────────────

    private fun attachMenu() {
        AlertDialog.Builder(this).setItems(arrayOf("Fotos", "Arquivo")) { _, i ->
            val intent = if (i == 0) Intent(Intent.ACTION_GET_CONTENT).setType("image/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            else Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            runCatching { @Suppress("DEPRECATION") startActivityForResult(intent, if (i == 0) PICK_IMAGES else PICK_FILES) }.onFailure { ui.toast("Nenhum app para escolher arquivos.") }
        }.show()
    }

    @Deprecated("Activity result callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || data == null || requestCode !in setOf(PICK_IMAGES, PICK_FILES)) return
        val uris = data.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } } ?: listOfNotNull(data.data)
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
            val chip = ui.row().apply { background = ui.shape(C.CARD2, 10, 1, C.LINE2); setPadding(dp(10), dp(6), dp(6), dp(6)) }
            chip.addView(ui.text((if (file.image) "🖼 " else "📄 ") + file.name.take(26), 12f, C.TX2).apply { maxLines = 1 })
            chip.addView(ui.text("  ✕", 12f, C.TX3).apply { contentDescription = "Remover ${file.name}"; setOnClickListener { attachments.remove(file); drawAttachments() } })
            attachmentStrip.addView(chip, ui.lp(WRAP, WRAP, end = 6, top = 4))
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

    private fun newConversationSheet() {
        val start = {
            ui.sheet("Nova conversa") { body, dialog ->
                var cwd = ""
                body.addView(ui.caption("Projeto"), ui.lp(top = 6, bottom = 8))
                val projectBox = ui.column()
                fun drawProjects() {
                    projectBox.removeAllViews()
                    val chips = mutableListOf<View>(ui.choice("Geral", cwd.isEmpty()) { cwd = ""; drawProjects() })
                    projects.forEach { p -> chips += ui.choice(p.str("name").ifBlank { p.str("cwd").substringAfterLast('/') }, cwd == p.str("cwd")) { cwd = p.str("cwd"); drawProjects() } }
                    projectBox.addView(ui.flow(chips))
                }
                drawProjects()
                body.addView(projectBox)
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
                    threadId = ""; threadTitle = "Nova conversa"; threadCwd = cwd; newCwd = cwd.ifEmpty { "" }
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

    private fun loadImage(path: String, view: ImageView) {
        images.get(path)?.let { view.setImageBitmap(it); return }
        view.setImageDrawable(ui.shape(0xff1a1d24.toInt(), 10))
        worker.execute {
            val bitmap = runCatching {
                val bytes = api.bytes(localUrl(path))
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (bounds.outWidth / sample > 1600 || bounds.outHeight / sample > 1600) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            }.getOrNull()
            runOnUiThread {
                if (bitmap != null) { images.put(path, bitmap); view.setImageBitmap(bitmap) }
                else view.contentDescription = "Imagem indisponível"
            }
        }
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

    private fun showImage(path: String, caption: String) = fullscreen { frame, dialog ->
        val image = ImageView(this).apply { scaleType = ImageView.ScaleType.FIT_CENTER; setOnClickListener { dialog.dismiss() }; contentDescription = caption }
        frame.addView(image, FrameLayout.LayoutParams(MATCH, MATCH))
        if (caption.isNotBlank()) frame.addView(ui.text(caption, 13f, C.TX2).apply { setPadding(dp(16), dp(12), dp(16), dp(20)) }, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.BOTTOM))
        loadImage(path, image)
    }

    private fun showPreview(path: String, label: String) = showWeb(BASE + localUrl(path), label)

    /** In-app WebView with the Harness session; HTML previews keep the server's sandbox CSP. */
    private fun showWeb(url: String, title: String) = fullscreen { frame, _ ->
        CookieManager.getInstance().apply { setAcceptCookie(true); api.sessionCookie().takeIf { it.isNotEmpty() }?.let { setCookie(ORIGIN, it) }; flush() }
        val web = WebView(this).apply {
            @Suppress("SetJavaScriptEnabled")
            settings.javaScriptEnabled = true
            settings.useWideViewPort = true; settings.loadWithOverviewMode = true; settings.builtInZoomControls = true; settings.displayZoomControls = false
            setBackgroundColor(C.BG)
            loadUrl(url)
        }
        val column = ui.column()
        column.addView(ui.text(title, 14f, C.TX, bold = true).apply { setPadding(dp(16), dp(14), dp(60), dp(10)); maxLines = 1 })
        column.addView(web, ui.lp(MATCH, 0, 1f))
        frame.addView(column, FrameLayout.LayoutParams(MATCH, MATCH))
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
        tools.addView(search)
        tools.addView(ui.segmented(listOf("Recentes", "Arquivadas"), if (archived) 1 else 0) { archived = it == 1; show(TAB_PROJECTS) }, ui.lp(top = 10))
        root.addView(tools)
        val list = ui.column().apply { setPadding(dp(14), dp(4), dp(14), dp(20)) }
        root.addView(ScrollView(this).apply { addView(list) }, ui.lp(MATCH, 0, 1f))
        list.addView(ui.text("Carregando…", 13.5f, C.TX3))
        request({ api.call("/api/threads?archived=$archived&search=${enc(query)}").optJSONArray("threads").objects() to api.call("/api/projects").optJSONArray("projects").objects() },
            onError = { list.removeAllViews(); list.addView(ui.text(it, 13.5f, C.RED)) }) { (threads, folders) ->
            projects = folders
            list.removeAllViews()
            if (threads.isEmpty()) { list.addView(ui.text(if (query.isEmpty()) "Nenhuma conversa ainda." else "Nada encontrado para \"$query\".", 14f, C.TX3), ui.lp(top = 20)); return@request }
            val used = mutableSetOf<String>()
            val groups = folders.mapNotNull { p ->
                val ids = p.optJSONArray("threadIds").strings().toSet()
                val inside = threads.filter { it.str("id") in ids || (it.str("cwd").isNotBlank() && it.str("cwd") == p.str("cwd")) }.filter { used.add(it.str("id")) }
                if (inside.isEmpty()) null else p to inside
            }.sortedByDescending { (_, t) -> t.maxOf { it.optDouble("updatedAt", 0.0) } }
            val loose = threads.filter { it.str("id") !in used }
            if (threadId.isNotEmpty() && !archived) threads.firstOrNull { it.str("id") == threadId }?.let { current ->
                list.addView(ui.caption("Aberta"), ui.lp(top = 4, bottom = 6))
                list.addView(threadRow(current, highlight = true).apply { background = ui.shape(0xff161a26.toInt(), 14, 1, 0xff33406a.toInt()) }, ui.lp(bottom = 12))
            }
            for ((project, inside) in groups) projectCard(list, project.str("name").ifBlank { project.str("cwd").substringAfterLast('/') }, inside)
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

    private fun projectCard(list: LinearLayout, name: String, threads: List<JSONObject>) {
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
            AlertDialog.Builder(this).setTitle(title).setItems(arrayOf("Abrir", "Renomear", if (archived) "Desarquivar" else "Arquivar")) { _, i ->
                when (i) {
                    0 -> openThread(t.str("id"), title, t.str("cwd"), t.str("accountId"))
                    1 -> renameThread(t.str("id"), title) { show(TAB_PROJECTS) }
                    2 -> request({ api.call("/api/threads/${enc(t.str("id"))}/${if (archived) "unarchive" else "archive"}", JSONObject()) }) { show(TAB_PROJECTS) }
                }
            }.show(); true
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
                    val chips = mutableListOf<View>(ui.choice("Geral", cwd.isEmpty()) { cwd = ""; draw() })
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
            list.addView(ui.action("+ Conectar nova conta") {
                AlertDialog.Builder(this).setTitle("Conectar nova conta").setMessage("O login de um provedor roda um terminal no servidor (Claude, Codex, Antigravity). Por enquanto esse fluxo fica no Web Harness.")
                    .setPositiveButton("Abrir Web Harness") { _, _ -> openLink("$BASE/") }.setNegativeButton("Fechar", null).show()
            }.apply { background = ui.shape(Color.TRANSPARENT, 14, 1, C.LINE2) }, ui.lp(MATCH, dp(46), top = 14))
            list.addView(ui.text("Codex Harness ${versionName()} · Android", 11.5f, C.TX3).apply { gravity = Gravity.CENTER }, ui.lp(top = 16))
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
        if (percent != null) card.addView(ui.progress(percent, if (percent >= rotation.optInt("switchAtPercent", 90)) C.AMBER else C.LAV), ui.lp(MATCH, dp(5), top = 10))
        val status = ui.row()
        val ok = acc.optBoolean("available")
        status.addView(ui.dot(if (!acc.optBoolean("enabled")) C.TX3 else if (ok) C.GREEN else C.RED, 7))
        status.addView(ui.text(if (!acc.optBoolean("enabled")) "Desativada" else if (ok) "Disponível" else acc.str("unavailableReason").ifBlank { "Indisponível" }, 11.5f, C.TX2), ui.lp(0, WRAP, 1f, start = 6))
        status.addView(ui.text(if (percent != null) "${percent.toInt()}% usado" else "uso não informado", 11f, C.TX3))
        card.addView(status, ui.lp(top = 8))
        card.setOnClickListener { accountSheet(acc) }
        return card
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
        acc.optJSONArray("usageWindows").objects().forEach { w ->
            val line = ui.row()
            line.addView(ui.text(mapOf("five_hour" to "Janela de 5 h", "seven_day" to "Semana", "seven_day_opus" to "Semana (Opus)")[w.str("window")] ?: w.str("window"), 12.5f, C.TX2), ui.lp(0, WRAP, 1f))
            line.addView(ui.text("${w.optDouble("percent").toInt()}%" + if (w.optLong("resetsAt") > 0) " · renova ${clockTime(w.optLong("resetsAt").toDouble())}" else "", 12f, C.TX3))
            body.addView(line, ui.lp(bottom = 4))
            body.addView(ui.progress(w.optDouble("percent")), ui.lp(MATCH, dp(5), bottom = 10))
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
