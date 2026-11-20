package br.com.nyxrooms.harness

import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.method.LinkMovementMethod
import android.text.style.*
import android.view.View
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout

/**
 * Small, escape-free Markdown renderer for assistant messages (native Views, no WebView):
 * headings, lists, quotes, code blocks, tables (monospace), inline code/bold/italic/links,
 * local project images as thumbnails and local .html links as preview cards — the same
 * conventions as the Web Harness.
 */
class Markdown(
    private val kit: Kit,
    private val onLink: (String) -> Unit,
    private val loadImage: (path: String, view: ImageView) -> Unit,
    private val onImage: (path: String, caption: String) -> Unit,
    private val onPreview: (path: String, label: String) -> Unit,
) {
    private val image = Regex("""^!\[([^\]]*)]\(\s*<?((?:file://)?/home/[^)>\s]+)>?\s*\)$""")
    private val htmlLink = Regex("""\[([^\]]+)]\(\s*<?((?:file://)?/home/[^)>\s]+\.html?)>?\s*\)""")
    private val inlineImage = Regex("""!\[([^\]]*)]\(\s*<?((?:file://)?/home/[^)>\s]+\.(?:png|jpe?g|webp|gif))>?\s*\)""", RegexOption.IGNORE_CASE)

    fun render(source: String, target: LinearLayout, size: Float = 15f) {
        val lines = source.replace("\r\n", "\n").split("\n")
        var i = 0
        val paragraph = mutableListOf<String>()
        fun flush() {
            if (paragraph.isEmpty()) return
            target.addView(inline(paragraph.joinToString("\n"), size), kit.lp(bottom = 8))
            paragraph.clear()
        }
        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trim()
            when {
                trimmed.startsWith("```") -> {
                    flush()
                    val code = mutableListOf<String>()
                    i++
                    while (i < lines.size && !lines[i].trim().startsWith("```")) { code += lines[i]; i++ }
                    target.addView(codeBlock(code.joinToString("\n")), kit.lp(bottom = 8))
                }
                trimmed.isEmpty() -> flush()
                Regex("^#{1,3}\\s+").containsMatchIn(trimmed) -> {
                    flush()
                    val level = trimmed.takeWhile { it == '#' }.length
                    target.addView(inline(trimmed.drop(level).trim(), if (level == 1) size + 4 else size + 2, bold = true), kit.lp(top = 4, bottom = 6))
                }
                Regex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$").matches(line) -> {
                    flush(); target.addView(View(kit.a).apply { setBackgroundColor(C.LINE) }, kit.lp(MATCH, kit.dp(1), top = 6, bottom = 10))
                }
                trimmed.startsWith("|") && i + 1 < lines.size && Regex("^\\|?\\s*:?-{3,}").containsMatchIn(lines[i + 1].trim()) -> {
                    flush()
                    val table = mutableListOf<String>()
                    while (i < lines.size && lines[i].trim().startsWith("|")) { table += lines[i]; i++ }
                    target.addView(tableBlock(table), kit.lp(bottom = 8))
                    continue
                }
                image.matches(trimmed) -> {
                    flush()
                    val m = image.find(trimmed)!!
                    target.addView(thumbnail(localPath(m.groupValues[2]), m.groupValues[1]), kit.lp(WRAP, WRAP, bottom = 8))
                }
                trimmed.contains("![") && inlineImage.containsMatchIn(trimmed) -> {
                    // Several images on one line: a horizontal strip of thumbnails.
                    flush()
                    val strip = kit.row()
                    for (m in inlineImage.findAll(trimmed)) strip.addView(thumbnail(localPath(m.groupValues[2]), m.groupValues[1], small = true), kit.lp(WRAP, WRAP, end = 8))
                    target.addView(HorizontalScrollView(kit.a).apply { isHorizontalScrollBarEnabled = false; addView(strip) }, kit.lp(bottom = 8))
                }
                htmlLink.containsMatchIn(trimmed) && htmlLink.find(trimmed)!!.value.length >= trimmed.length - 2 -> {
                    flush()
                    val m = htmlLink.find(trimmed)!!
                    target.addView(previewCard(localPath(m.groupValues[2]), m.groupValues[1]), kit.lp(bottom = 8))
                }
                Regex("^\\s*([-*+]|\\d+[.)])\\s+").containsMatchIn(line) -> {
                    flush()
                    val marker = Regex("^\\s*([-*+]|\\d+[.)])\\s+").find(line)!!
                    val indent = line.takeWhile { it == ' ' }.length / 2
                    val bullet = marker.groupValues[1].let { if (it.first().isDigit()) it else "•" }
                    val item = kit.row().apply { gravity = android.view.Gravity.TOP }
                    item.addView(kit.text(bullet, size, C.TX2), kit.lp(kit.dp(22), WRAP))
                    item.addView(inline(line.substring(marker.range.last + 1), size), kit.lp(0, WRAP, 1f))
                    target.addView(item, kit.lp(bottom = 4, start = indent * 14))
                }
                trimmed.startsWith(">") -> {
                    flush()
                    val quote = mutableListOf<String>()
                    while (i < lines.size && lines[i].trim().startsWith(">")) { quote += lines[i].trim().removePrefix(">").trim(); i++ }
                    target.addView(inline(quote.joinToString("\n"), size, color = C.TX2).apply {
                        background = kit.shape(0xff20222b.toInt(), 8); setPadding(kit.dp(12), kit.dp(8), kit.dp(12), kit.dp(8))
                    }, kit.lp(bottom = 8))
                    continue
                }
                else -> paragraph += line
            }
            i++
        }
        flush()
    }

    private fun localPath(raw: String) = raw.removePrefix("file://")

    private fun codeBlock(code: String) = HorizontalScrollView(kit.a).apply {
        background = kit.shape(0xff101113.toInt(), 10, 1, 0xff34353a.toInt())
        addView(kit.text(code, 12.5f, 0xffc9cfdb.toInt(), mono = true).apply {
            setPadding(kit.dp(12), kit.dp(10), kit.dp(12), kit.dp(10)); setTextIsSelectable(true)
        })
    }

    private fun tableBlock(lines: List<String>): View {
        val rows = lines.filterIndexed { index, _ -> index != 1 }.map { line ->
            line.trim().trim('|').split(Regex("(?<!\\\\)\\|")).map { it.trim().replace("\\|", "|").replace("**", "").replace("`", "") }
        }
        val columns = rows.maxOf { it.size }
        val widths = (0 until columns).map { c -> rows.maxOf { it.getOrElse(c) { "" }.length }.coerceAtMost(40) }
        val text = SpannableStringBuilder()
        rows.forEachIndexed { r, cells ->
            val start = text.length
            text.append(cells.mapIndexed { c, cell -> cell.take(40).padEnd(widths[c]) }.joinToString("  │ ").trimEnd()).append('\n')
            if (r == 0) {
                text.setSpan(StyleSpan(Typeface.BOLD), start, text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                text.append(widths.joinToString("──┼─") { "─".repeat(it) }).append('\n')
            }
        }
        return HorizontalScrollView(kit.a).apply {
            background = kit.shape(0xff15161a.toInt(), 10, 1, C.LINE)
            addView(kit.text(text.trimEnd(), 12f, C.TX, mono = true).apply { setPadding(kit.dp(12), kit.dp(10), kit.dp(12), kit.dp(10)); setTextIsSelectable(true) })
        }
    }

    private fun thumbnail(path: String, caption: String, small: Boolean = false): View {
        val box = kit.column()
        val view = ImageView(kit.a).apply {
            adjustViewBounds = true; scaleType = ImageView.ScaleType.FIT_CENTER
            maxHeight = kit.dp(if (small) 180 else 320); maxWidth = kit.dp(if (small) 140 else 320)
            background = kit.shape(0xff101113.toInt(), 10, 1, 0xff34353a.toInt())
            setPadding(kit.dp(1), kit.dp(1), kit.dp(1), kit.dp(1))
            minimumHeight = kit.dp(60); minimumWidth = kit.dp(60)
            contentDescription = caption.ifBlank { "Imagem" }
            setOnClickListener { onImage(path, caption) }
        }
        box.addView(view, kit.lp(WRAP, WRAP))
        if (caption.isNotBlank()) box.addView(kit.text(caption, 11.5f, C.TX3).apply { maxWidth = kit.dp(if (small) 140 else 320) }, kit.lp(WRAP, WRAP, top = 4))
        loadImage(path, view)
        return box
    }

    private fun previewCard(path: String, label: String) = kit.card(0xff15161a.toInt(), 0xff34353a.toInt(), 11, 10).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = android.view.Gravity.CENTER_VERTICAL
        val titles = kit.column()
        titles.addView(kit.text(label, 14f, bold = true).apply { maxLines = 1 })
        titles.addView(kit.text(path.substringAfterLast('/'), 11.5f, C.TX3).apply { maxLines = 1 })
        addView(titles, kit.lp(0, WRAP, 1f))
        addView(kit.action("Mostrar prévia", primary = true) { onPreview(path, label) }, kit.lp(WRAP, kit.dp(38)))
    }

    /** Inline markup: `code`, **bold**, *italic*, [label](url) and local file links. */
    fun inline(source: String, size: Float, bold: Boolean = false, color: Int = C.TX) = kit.text("", size, color, bold).apply {
        val out = SpannableStringBuilder()
        val pattern = Regex("""`([^`]+)`|\*\*([^*]+)\*\*|(?<![*\w])\*([^*\n]+)\*(?!\w)|\[([^\]]+)]\(\s*<?([^)>\s]+)>?\s*\)""")
        var last = 0
        for (m in pattern.findAll(source)) {
            out.append(source, last, m.range.first)
            val start = out.length
            when {
                m.groups[1] != null -> {
                    out.append(m.groupValues[1])
                    out.setSpan(TypefaceSpan("monospace"), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(BackgroundColorSpan(0xff262a33.toInt()), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(0xffdfe4ff.toInt()), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                m.groups[2] != null -> { out.append(m.groupValues[2]); out.setSpan(StyleSpan(Typeface.BOLD), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
                m.groups[3] != null -> { out.append(m.groupValues[3]); out.setSpan(StyleSpan(Typeface.ITALIC), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
                else -> {
                    val url = m.groupValues[5]
                    out.append(m.groupValues[4])
                    out.setSpan(object : ClickableSpan() {
                        override fun onClick(widget: View) = onLink(url)
                        override fun updateDrawState(ds: TextPaint) { ds.color = 0xff8fb2ff.toInt(); ds.isUnderlineText = true }
                    }, start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
            last = m.range.last + 1
        }
        out.append(source, last, source.length)
        text = out
        // Selectable text resets the movement method; links need LinkMovementMethod, so pick one.
        if (out.getSpans(0, out.length, ClickableSpan::class.java).isNotEmpty()) movementMethod = LinkMovementMethod.getInstance()
        else setTextIsSelectable(true)
        setLineSpacing(kit.dp(3).toFloat(), 1f)
    }
}
