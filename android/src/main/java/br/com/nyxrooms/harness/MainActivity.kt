package br.com.nyxrooms.harness

import android.app.*
import android.os.*
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.method.PasswordTransformationMethod
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.text.InputType
import android.util.Base64
import android.view.*
import android.widget.*
import org.json.*
import java.net.URL
import java.net.URLEncoder
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val ORIGIN = "https://nyxrooms.com"
private const val BASE = "$ORIGIN/codex-agent"
private const val COOKIE = "__Secure-codex_session"
private const val BG = 0xff101218.toInt()
private const val CARD = 0xff1b2030.toInt()
private const val INK = 0xffeef0fa.toInt()
private const val MUTED = 0xffaab3cf.toInt()
private const val BLUE = 0xff3656a0.toInt()
private fun enc(value: String) = URLEncoder.encode(value, "UTF-8")
private fun obj(vararg pairs: Pair<String, Any>) = JSONObject(mapOf(*pairs))
private fun JSONArray?.objects() = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
private fun JSONObject.str(key: String) = if (isNull(key)) "" else optString(key)
private class SessionExpired : Exception("Sua sessão expirou. Entre novamente.")

private class HarnessApi(context: Context) {
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

    fun clear() {
        cookie = ""
        prefs.edit().remove("encrypted").apply()
    }

    fun call(path: String, data: JSONObject? = null): JSONObject {
        val conn = URL(BASE + path).openConnection() as javax.net.ssl.HttpsURLConnection
        try {
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 12000
            conn.readTimeout = 25000
            conn.setRequestProperty("Accept", "application/json")
            if (path.startsWith("/api/") && cookie.isNotEmpty()) conn.setRequestProperty("Cookie", "$COOKIE=$cookie")
            if (data != null) {
                conn.requestMethod = "POST"
                conn.setRequestProperty("Origin", ORIGIN)
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                conn.doOutput = true
                conn.outputStream.use { it.write(data.toString().toByteArray(Charsets.UTF_8)) }
            }
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
}

class MainActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val clock = Handler(Looper.getMainLooper())
    private lateinit var api: HarnessApi
    private lateinit var root: LinearLayout
    private var screen = 0
    private var epoch = 0
    private var threadId = ""
    private var titleText = ""
    private var accountId = "codex"
    private var cwd = ""
    private var next = ""
    private var archived = false
    private var query = ""
    private var accounts = emptyList<JSONObject>()
    private var projects = emptyList<JSONObject>()
    private var rows = listOf<JSONObject>()
    private var older = listOf<JSONObject>()
    private var latest = listOf<JSONObject>()
    private var rendered = ""
    private var historyPending = false
    private lateinit var history: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var composer: EditText
    private lateinit var send: Button

    private val poll = object : Runnable {
        override fun run() {
            if (screen == 2 && threadId.isNotEmpty()) readHistory(silent = true)
            clock.postDelayed(this, 2500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = BG
        window.navigationBarColor = BG
        api = HarnessApi(this)
        page(0, "Codex Harness").addView(label("Conectando ao Nyxrooms…", 16, MUTED))
        request({ api.call("/api/auth/status") }, onError = { login(it) }) {
            if (it.optBoolean("authenticated")) library() else login()
        }
    }

    override fun onStart() {
        super.onStart()
        clock.post(poll)
        if (!updateChecked) {
            updateChecked = true
            checkUpdate(manual = false)
        }
    }

    private var updateChecked = false
    private fun checkUpdate(manual: Boolean) {
        worker.execute {
            val result = runCatching { api.call("/android-release.json") }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                result.onFailure { if (manual) toast("Não foi possível verificar atualizações.") }
                result.onSuccess { release ->
                    val installed = packageManager.getPackageInfo(packageName, 0)
                    @Suppress("DEPRECATION")
                    val versionCode = if (Build.VERSION.SDK_INT >= 28) installed.longVersionCode else installed.versionCode.toLong()
                    if (release.optLong("versionCode") <= versionCode) {
                        if (manual) toast("Você já está na versão mais recente.")
                        return@onSuccess
                    }
                    AlertDialog.Builder(this)
                        .setTitle("Atualização disponível")
                        .setMessage("Codex Harness ${release.str("versionName")}\n\n${release.str("notes")}")
                        .setPositiveButton("Abrir download") { _, _ ->
                            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("$BASE/android.html"))) }
                                .onFailure { toast("Não foi possível abrir a página de download.") }
                        }
                        .setNegativeButton("Depois", null).show()
                }
            }
        }
    }
    override fun onStop() { clock.removeCallbacks(poll); super.onStop() }
    override fun onDestroy() { worker.shutdownNow(); super.onDestroy() }

    private fun <T> request(work: () -> T, onError: (String) -> Unit = { toast(it) }, done: (T) -> Unit) {
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

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()
    private fun surface(color: Int, radius: Int = 16) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(radius).toFloat()
    }
    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    private fun row() = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
    private fun label(text: String, size: Int, color: Int = INK, bold: Boolean = false) = TextView(this).apply {
        this.text = text; textSize = size.toFloat(); setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }
    private fun button(text: String, action: () -> Unit) = Button(this).apply {
        this.text = text; isAllCaps = false; setTextColor(INK)
        background = surface(BLUE, 12)
        setPadding(dp(14), 0, dp(14), 0); minHeight = dp(48)
        setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(-2, dp(48)).apply { setMargins(0, dp(5), dp(6), dp(5)) }
    }
    private fun field(hint: String, type: Int = InputType.TYPE_CLASS_TEXT) = EditText(this).apply {
        this.hint = hint; inputType = type; setTextColor(INK); setHintTextColor(MUTED)
        setPadding(dp(14), dp(12), dp(14), dp(12)); background = surface(CARD, 12)
    }

    private fun page(target: Int, title: String): LinearLayout {
        epoch++; screen = target; historyPending = false
        root = column().apply {
            setPadding(dp(16), dp(8), dp(16), dp(8))
            setBackgroundColor(BG)
            val heading = row()
            if (target == 2) heading.addView(button("‹") { library() }.apply { contentDescription = "Conversas" })
            heading.addView(label(title, 23, bold = true).apply { maxLines = 2 }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(heading)
        }
        setContentView(root)
        return root
    }

    private fun login(message: String = "", challenge: String = "", hint: String = "") {
        page(0, "Codex Harness")
        root.removeAllViews()
        val form = column().apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(24), dp(10), dp(24))
        }
        root.addView(ScrollView(this).apply {
            isFillViewport = true
            addView(form)
        }, LinearLayout.LayoutParams(-1, 0, 1f))
        form.addView(ImageView(this).apply {
            setImageResource(R.mipmap.ic_launcher)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(64), dp(64)))
        form.addView(label("Codex Harness", 30, bold = true).apply {
            setPadding(0, dp(16), 0, dp(8))
        })
        form.addView(label(if (challenge.isEmpty()) "Entre com sua senha do Web Harness." else "Digite o código enviado para $hint.", 16, MUTED).apply {
            setPadding(0, 0, 0, dp(24))
        })
        val fieldLabel = if (challenge.isEmpty()) "Senha" else "Código de verificação"
        val input = field(if (challenge.isEmpty()) "Digite sua senha" else "Código do e-mail",
            if (challenge.isEmpty()) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_CLASS_NUMBER)
        input.id = View.generateViewId()
        input.isSingleLine = true
        form.addView(label(fieldLabel, 14, bold = true).apply {
            labelFor = input.id
            setPadding(0, 0, 0, dp(8))
        })
        if (challenge.isEmpty()) {
            val passwordRow = row().apply { background = surface(CARD, 12) }
            input.background = null
            input.transformationMethod = PasswordTransformationMethod.getInstance()
            passwordRow.addView(input, LinearLayout.LayoutParams(0, dp(56), 1f))
            val eye = ImageButton(this).apply {
                background = null
                setColorFilter(INK)
            }
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
            passwordRow.addView(eye, LinearLayout.LayoutParams(dp(56), dp(56)))
            form.addView(passwordRow, LinearLayout.LayoutParams(-1, -2))
        } else form.addView(input, LinearLayout.LayoutParams(-1, dp(56)))
        val status = label(message, 14, MUTED)
        lateinit var action: Button
        action = button(if (challenge.isEmpty()) "Enviar código" else "Entrar") {
            val text = input.text.toString()
            if (text.isBlank()) return@button
            action.isEnabled = false
            status.text = "Conectando…"
            request({
                if (challenge.isEmpty()) api.call("/api/auth/login/start", obj("password" to text))
                else api.call("/api/auth/login/verify", obj("challengeId" to challenge, "code" to text.trim()))
            }, onError = { status.text = it; action.isEnabled = true }) {
                input.text.clear()
                if (challenge.isEmpty()) login(challenge = it.getString("challengeId"), hint = it.str("emailHint"))
                else library()
            }
        }
        action.layoutParams = LinearLayout.LayoutParams(-1, dp(54)).apply { topMargin = dp(16) }
        form.addView(action)
        if (challenge.isNotEmpty()) form.addView(button("Voltar para a senha") { login() }.apply {
            background = surface(CARD, 12)
            layoutParams = LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(10) }
        })
        form.addView(status.apply { setPadding(0, dp(12), 0, 0) })
        input.imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE
        input.setOnEditorActionListener { _, id, _ ->
            if (id != android.view.inputmethod.EditorInfo.IME_ACTION_DONE) false
            else { if (action.isEnabled) action.performClick(); true }
        }
        form.isFocusableInTouchMode = true
        form.requestFocus()
    }

    private fun library() {
        page(1, "Conversas")
        val menu = row()
        menu.addView(button("Novo chat") { chooseAccount() })
        menu.addView(button("Atualizar") { library() })
        menu.addView(button("⋮") { options() }.apply { contentDescription = "Opções" })
        root.addView(menu)
        val search = field("Buscar no histórico").apply {
            isSingleLine = true; setText(query); imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH
            setOnEditorActionListener { _, _, _ -> query = text.toString().trim(); library(); true }
        }
        val searchRow = row()
        searchRow.addView(search, LinearLayout.LayoutParams(0, -2, 1f))
        searchRow.addView(button("Buscar") { query = search.text.toString().trim(); library() })
        root.addView(searchRow)
        val status = label(if (archived) "Arquivadas · carregando…" else "Carregando histórico…", 14, MUTED)
        root.addView(status)
        val list = ListView(this).apply { dividerHeight = dp(5); cacheColorHint = Color.TRANSPARENT }
        root.addView(list, LinearLayout.LayoutParams(-1, 0, 1f))
        request({
            api.call("/api/threads?archived=$archived&search=${enc(query)}").optJSONArray("threads").objects()
        }, onError = { status.text = it }) { result ->
            rows = result
            status.text = if (rows.isEmpty()) "Nenhuma conversa encontrada." else if (archived) "Conversas arquivadas" else "Conversas recentes"
            list.adapter = object : BaseAdapter() {
                override fun getCount() = result.size
                override fun getItem(position: Int) = result[position]
                override fun getItemId(position: Int) = position.toLong()
                override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                    val item = getItem(position)
                    return (convertView as? TextView ?: label("", 16).apply {
                        setPadding(dp(14), dp(12), dp(14), dp(12)); background = surface(CARD); maxLines = 3
                    }).apply { text = threadTitle(item) }
                }
            }
            list.setOnItemClickListener { _, _, position, _ ->
                val item = result[position]
                conversation(item.str("id"), threadTitle(item), item.str("accountId").ifEmpty { "codex" })
            }
        }
    }

    private fun threadTitle(item: JSONObject) = item.str("name").ifBlank { item.str("preview") }.ifBlank { "Conversa sem título" }
    private fun options() {
        AlertDialog.Builder(this).setItems(arrayOf(if (archived) "Conversas recentes" else "Conversas arquivadas", "Contas conectadas", "Sair da conta", "Verificar atualizações")) { _, index ->
            when (index) {
                0 -> { archived = !archived; library() }
                1 -> request({ api.call("/api/accounts").optJSONArray("accounts").objects() }) { data ->
                    val text = data.joinToString("\n\n") {
                        val usage = if (it.isNull("percent")) "" else " · ${it.optInt("percent")}% usado"
                        "${it.str("label")} · ${if (it.optBoolean("available")) "Disponível" else "Indisponível"}$usage"
                    }
                    AlertDialog.Builder(this).setTitle("Contas conectadas").setMessage(text).setPositiveButton("Fechar", null).show()
                }
                2 -> request({ api.call("/api/auth/logout", JSONObject()); api.clear() }) { login() }
                3 -> checkUpdate(manual = true)
            }
        }.show()
    }

    private fun chooseAccount() {
        request({ api.call("/api/accounts").optJSONArray("accounts").objects() to api.call("/api/projects").optJSONArray("projects").objects() }) { (available, folders) ->
            accounts = available.filter { it.optBoolean("enabled") && it.optBoolean("available") }
            projects = folders.filter { it.str("cwd").isNotBlank() || it.str("path").isNotBlank() }
            if (accounts.isEmpty()) { toast("Nenhuma conta disponível."); return@request }
            AlertDialog.Builder(this).setTitle("Conta do novo chat").setItems(accounts.map { it.str("label") }.toTypedArray()) { _, i ->
                val account = accounts[i].str("id")
                val names = listOf("Geral") + projects.map { it.str("name").ifBlank { it.str("path") } }
                AlertDialog.Builder(this).setTitle("Projeto").setItems(names.toTypedArray()) { _, j ->
                    cwd = projects.getOrNull(j - 1)?.let { it.str("cwd").ifBlank { it.str("path") } }.orEmpty()
                    conversation("", "Novo chat", account)
                }.show()
            }.show()
        }
    }

    private fun conversation(id: String, title: String, account: String) {
        threadId = id; titleText = title; accountId = account; next = ""; older = emptyList(); latest = emptyList(); rendered = ""
        page(2, title)
        val actions = row()
        actions.addView(button("Atualizar") { readHistory() })
        actions.addView(button("Interromper") {
            if (threadId.isNotEmpty()) request({ api.call("/api/threads/${enc(threadId)}/interrupt", JSONObject()) }) { readHistory() }
        })
        root.addView(actions)
        history = column()
        scroll = ScrollView(this).apply { isFillViewport = true; addView(history) }
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        val bar = row()
        composer = field("Escreva uma mensagem", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE).apply { maxLines = 5 }
        bar.addView(composer, LinearLayout.LayoutParams(0, -2, 1f))
        send = button("Enviar") { submit() }
        bar.addView(send)
        root.addView(bar)
        if (id.isNotEmpty()) readHistory()
        else history.addView(label("As mensagens ficam disponíveis também no Web Harness.", 15, MUTED))
    }

    private fun submit() {
        val text = composer.text.toString().trim()
        if (text.isEmpty()) return
        val body = obj("text" to text, "threadId" to threadId, "accountId" to accountId)
        if (threadId.isEmpty() && cwd.isNotEmpty()) body.put("cwd", cwd)
        send.isEnabled = false
        request({ api.call("/api/turn", body) }, onError = { send.isEnabled = true; toast(it) }) {
            send.isEnabled = true
            if (composer.text.toString().trim() == text) composer.text.clear()
            threadId = it.str("threadId").ifBlank { threadId }
            if (it.optBoolean("queued")) toast("Mensagem adicionada à fila.")
            readHistory()
        }
    }

    private fun readHistory(silent: Boolean = false, before: String = "") {
        if (threadId.isBlank() || historyPending) return
        historyPending = true
        val id = threadId
        request({ api.call("/api/threads/${enc(id)}/history" + if (before.isEmpty()) "" else "?cursor=${enc(before)}") },
            onError = { historyPending = false; if (!silent) toast(it) }) { data ->
            historyPending = false
            val turns = data.optJSONArray("turns").objects()
            data.optJSONObject("thread")?.str("accountId")?.takeIf { it.isNotBlank() }?.let { accountId = it }
            if (before.isEmpty()) {
                val oldIds = older.map { it.str("id") }.toSet()
                if (older.isNotEmpty()) {
                    val newIds = turns.map { it.str("id") }.toSet()
                    older += latest.filter { it.str("id") !in newIds && it.str("id") !in oldIds }
                } else next = data.str("nextCursor")
                latest = turns
            } else {
                older = turns + older
                next = data.str("nextCursor")
            }
            drawHistory(before.isNotEmpty())
        }
    }

    private fun drawHistory(prepend: Boolean) {
        val turns = (older + latest).distinctBy { it.str("id") }
        val fingerprint = next + turns.joinToString { it.toString() }
        if (fingerprint == rendered) return
        rendered = fingerprint
        val previousHeight = history.height
        val previousY = scroll.scrollY
        val atBottom = previousHeight - (previousY + scroll.height) < dp(90)
        history.removeAllViews()
        if (next.isNotEmpty()) history.addView(button("Carregar mensagens anteriores") { readHistory(before = next) })
        for (turn in turns) {
            for (item in turn.optJSONArray("items").objects()) {
                when (item.str("type")) {
                    "userMessage" -> {
                        val content = item.optJSONArray("content").objects()
                        val text = content.filter { it.str("type") == "text" }.joinToString("\n") { it.str("text") }
                        bubble("Você", text.ifBlank { "Mensagem com anexo" }, true)
                    }
                    "agentMessage" -> bubble("Assistente", item.str("text"))
                    "mcpToolCall" -> detail("Ferramenta · ${item.str("tool")}", item.opt("result") ?: item.opt("error"))
                    "commandExecution" -> detail("Comando · ${item.str("command")}", item.opt("aggregatedOutput"))
                    "fileChange" -> detail("Alterações em arquivos", item.opt("changes"))
                }
            }
            if (turn.str("status") == "inProgress") bubble("Harness", "Respondendo…")
            if (!turn.isNull("error")) bubble("Harness", turn.optJSONObject("error")?.str("message") ?: turn.str("error"))
        }
        scroll.post {
            if (prepend) scroll.scrollTo(0, previousY + history.height - previousHeight)
            else if (atBottom) scroll.fullScroll(View.FOCUS_DOWN)
        }
    }

    private fun detail(title: String, value: Any?) {
        val text = when (value) {
            null, JSONObject.NULL -> ""
            is JSONObject -> value.toString(2)
            is JSONArray -> value.toString(2)
            else -> value.toString()
        }
        val toggle = label(title, 13, MUTED).apply { setPadding(dp(8), dp(8), dp(8), dp(8)) }
        history.addView(toggle)
        if (text.isNotBlank()) {
            val output = label(text, 13).apply {
                typeface = Typeface.MONOSPACE; visibility = View.GONE; setTextIsSelectable(true)
            }
            history.addView(output)
            toggle.setOnClickListener { output.visibility = if (output.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        }
    }

    private fun bubble(author: String, text: String, user: Boolean = false) {
        if (text.isBlank()) return
        val box = column().apply {
            background = surface(if (user) 0xff23345e.toInt() else CARD)
            setPadding(dp(14), dp(10), dp(14), dp(12))
            addView(label(author, 12, MUTED, true))
            addView(label(text, 16).apply { setTextIsSelectable(true); setLineSpacing(dp(3).toFloat(), 1f) })
        }
        history.addView(box, LinearLayout.LayoutParams(-1, -2).apply {
            topMargin = dp(8); bottomMargin = dp(3)
            if (user) marginStart = dp(22) else marginEnd = dp(12)
        })
    }

    @Deprecated("Android back callback")
    override fun onBackPressed() {
        if (screen == 2) library() else super.onBackPressed()
    }
}
