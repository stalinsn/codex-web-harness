package br.com.nyxrooms.harness

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.*

/** Palette from docs/mockups (dark, clean). */
object C {
    const val BG = 0xff0d0f13.toInt()
    const val PANEL = 0xff14171c.toInt()
    const val CARD = 0xff191c22.toInt()
    const val CARD2 = 0xff1e2229.toInt()
    const val LINE = 0xff2a2f38.toInt()
    const val LINE2 = 0xff343a45.toInt()
    const val TX = 0xffe8eaef.toInt()
    const val TX2 = 0xffa3a9b5.toInt()
    const val TX3 = 0xff6d7480.toInt()
    const val BLUE = 0xff24477a.toInt()
    const val BLUE_LINE = 0xff2f5690.toInt()
    const val LAV = 0xffa7b2ff.toInt()
    const val LAV_DARK = 0xff151735.toInt()
    const val SELECT = 0xff1f2340.toInt()
    const val SELECT_LINE = 0xff4b55b8.toInt()
    const val GREEN = 0xff3ecf8e.toInt()
    const val RED = 0xfff26d6d.toInt()
    const val AMBER = 0xfff2b84b.toInt()
    const val ORANGE = 0xffe8774a.toInt()
    const val CYAN = 0xff4fb6e8.toInt()
}

const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

open class Kit(val a: Activity) {
    fun dp(n: Int) = (n * a.resources.displayMetrics.density).toInt()
    fun toast(text: String) = Toast.makeText(a, text, Toast.LENGTH_LONG).show()

    fun shape(fill: Int, radius: Int = 16, stroke: Int = 0, strokeColor: Int = C.LINE) = GradientDrawable().apply {
        setColor(fill); cornerRadius = dp(radius).toFloat()
        if (stroke > 0) setStroke(dp(stroke), strokeColor)
    }

    fun column() = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL }
    fun row() = LinearLayout(a).apply { gravity = Gravity.CENTER_VERTICAL }
    fun lp(w: Int = MATCH, h: Int = WRAP, weight: Float = 0f, top: Int = 0, bottom: Int = 0, start: Int = 0, end: Int = 0) =
        LinearLayout.LayoutParams(w, h, weight).apply { setMargins(dp(start), dp(top), dp(end), dp(bottom)) }
    fun space() = View(a)

    fun text(value: CharSequence, size: Float = 14f, color: Int = C.TX, bold: Boolean = false, mono: Boolean = false) = TextView(a).apply {
        text = value; textSize = size; setTextColor(color)
        typeface = when { mono -> Typeface.MONOSPACE; bold -> Typeface.create(Typeface.DEFAULT, Typeface.BOLD); else -> Typeface.DEFAULT }
        setLineSpacing(dp(2).toFloat(), 1f)
    }
    fun caption(value: String) = text(value.uppercase(), 10.5f, C.TX3, bold = true).apply { letterSpacing = 0.12f }

    fun card(fill: Int = C.CARD, stroke: Int = C.LINE, radius: Int = 16, pad: Int = 12) = column().apply {
        background = shape(fill, radius, 1, stroke); setPadding(dp(pad), dp(pad), dp(pad), dp(pad))
    }

    fun pill(value: String, fg: Int = C.TX2, fill: Int = Color.TRANSPARENT, stroke: Int = C.LINE2) = text(value, 11f, fg).apply {
        background = shape(fill, 99, 1, stroke); setPadding(dp(8), dp(3), dp(8), dp(3)); maxLines = 1
    }
    fun statusPill(kind: String, value: String) = when (kind) {
        "ok" -> pill(value, 0xff7fe3b4.toInt(), 0xff122a20.toInt(), 0xff245c43.toInt())
        "bad" -> pill(value, 0xffff9c9c.toInt(), 0xff2c1515.toInt(), 0xff6b2a2a.toInt())
        "warn" -> pill(value, 0xffffd27a.toInt(), 0xff2b2311.toInt(), 0xff6b5420.toInt())
        "info" -> pill(value, 0xffb9c8ff.toInt(), 0xff1b2440.toInt(), 0xff3e5aa0.toInt())
        else -> pill(value)
    }

    fun dot(color: Int, size: Int = 8) = View(a).apply {
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) }
        layoutParams = LinearLayout.LayoutParams(dp(size), dp(size))
    }

    /** Primary (lavender) or secondary (outlined) action. */
    fun action(label: String, primary: Boolean = false, onClick: () -> Unit) = TextView(a).apply {
        text = label; textSize = 13.5f; gravity = Gravity.CENTER
        setTextColor(if (primary) C.LAV_DARK else C.TX)
        if (primary) typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        background = if (primary) shape(C.LAV, 14) else shape(C.CARD2, 14, 1, C.LINE2)
        setPadding(dp(14), 0, dp(14), 0); minHeight = dp(44)
        isClickable = true; isFocusable = true
        setOnClickListener { onClick() }
    }

    fun iconButton(icon: Int, description: String, tint: Int = C.TX2, bordered: Boolean = true, onClick: () -> Unit) = ImageButton(a).apply {
        setImageResource(icon); setColorFilter(tint); contentDescription = description
        background = if (bordered) shape(Color.TRANSPARENT, 12, 1, C.LINE) else null
        setPadding(dp(8), dp(8), dp(8), dp(8)); scaleType = ImageView.ScaleType.FIT_CENTER
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(dp(40), dp(40))
    }

    fun field(hint: String, multi: Boolean = false) = EditText(a).apply {
        this.hint = hint; setTextColor(C.TX); setHintTextColor(C.TX3); textSize = 15f
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or (if (multi) InputType.TYPE_TEXT_FLAG_MULTI_LINE else 0)
        if (!multi) isSingleLine = true
        background = shape(C.PANEL, 13, 1, C.LINE); setPadding(dp(14), dp(11), dp(14), dp(11))
    }

    fun progress(percent: Double?, color: Int = C.LAV) = FrameLayout(a).apply {
        background = shape(0xff262a33.toInt(), 9)
        val fill = View(a).apply { background = shape(color, 9) }
        val fraction = ((percent ?: 0.0) / 100.0).coerceIn(0.0, 1.0)
        addView(fill, FrameLayout.LayoutParams(0, MATCH))
        post { fill.layoutParams = FrameLayout.LayoutParams((width * fraction).toInt(), MATCH) }
        layoutParams = LinearLayout.LayoutParams(MATCH, dp(5))
    }

    /** Segmented control; returns the container. */
    fun segmented(options: List<String>, selected: Int, onPick: (Int) -> Unit) = row().apply {
        background = shape(C.PANEL, 13, 1, C.LINE); setPadding(dp(3), dp(3), dp(3), dp(3))
        options.forEachIndexed { index, option ->
            addView(text(option, 12.5f, if (index == selected) C.TX else C.TX2, bold = index == selected).apply {
                gravity = Gravity.CENTER; setPadding(0, dp(8), 0, dp(8))
                if (index == selected) background = shape(0xff252a35.toInt(), 10)
                setOnClickListener { onPick(index) }
            }, lp(0, WRAP, 1f))
        }
    }

    /** Option chip used in sheets (account, model, effort). */
    fun choice(label: String, on: Boolean, onClick: () -> Unit) = text(label, 13f, if (on) C.TX else C.TX2, bold = on).apply {
        gravity = Gravity.CENTER; setPadding(dp(12), dp(10), dp(12), dp(10)); maxLines = 1
        background = if (on) shape(C.SELECT, 12, 1, C.SELECT_LINE) else shape(C.CARD, 12, 1, C.LINE)
        setOnClickListener { onClick() }
    }

    /** Wrapping row of chips. */
    fun flow(views: List<View>, gap: Int = 6): LinearLayout {
        val box = column()
        var line = row()
        var used = 0
        val max = a.resources.displayMetrics.widthPixels - dp(56)
        for (view in views) {
            view.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
            val w = view.measuredWidth + dp(gap)
            if (used > 0 && used + w > max) { box.addView(line, lp(bottom = gap)); line = row(); used = 0 }
            line.addView(view, lp(WRAP, WRAP, end = gap)); used += w
        }
        if (line.childCount > 0) box.addView(line, lp())
        return box
    }

    /**
     * Bottom sheet: full-screen translucent dialog with a dim scrim (tap closes), a grabber and a
     * body that follows the finger (drag down closes). Back also closes. Content scrolls inside.
     */
    fun sheet(title: String, build: (body: LinearLayout, dialog: Dialog) -> Unit): Dialog {
        val dialog = Dialog(a, android.R.style.Theme_Translucent_NoTitleBar)
        val root = FrameLayout(a)
        val scrim = View(a).apply { setBackgroundColor(0x9e04050a.toInt()); contentDescription = "Fechar painel" }
        root.addView(scrim, FrameLayout.LayoutParams(MATCH, MATCH))
        lateinit var sheet: DragSheet
        sheet = DragSheet(a, 0.92f) { dialog.dismiss() }.apply {
            background = shape(0xff14171d.toInt(), 26).apply { cornerRadii = floatArrayOf(dp(26).toFloat(), dp(26).toFloat(), dp(26).toFloat(), dp(26).toFloat(), 0f, 0f, 0f, 0f) }
        }
        val top = column().apply { setPadding(dp(16), dp(10), dp(16), dp(4)) }
        top.addView(View(a).apply { background = shape(0xff4a505c.toInt(), 3) }, lp(dp(44), dp(5)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(12) })
        val head = row()
        head.addView(text(title, 17f, bold = true).apply { maxLines = 2 }, lp(0, WRAP, 1f))
        head.addView(text("✕", 16f, C.TX3).apply { setPadding(dp(12), dp(6), dp(4), dp(6)); setOnClickListener { sheet.close() }; contentDescription = "Fechar" })
        top.addView(head, lp(bottom = 4))
        sheet.addView(top, lp())
        val body = column().apply { setPadding(dp(16), dp(4), dp(16), dp(26)) }
        build(body, dialog)
        val scroll = ScrollView(a).apply { addView(body); isVerticalScrollBarEnabled = false; overScrollMode = View.OVER_SCROLL_NEVER }
        sheet.scroll = scroll
        sheet.addView(scroll, lp(MATCH, WRAP))
        root.addView(sheet, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.BOTTOM))
        scrim.setOnClickListener { sheet.close() }
        dialog.setContentView(root)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(MATCH, MATCH)
            statusBarColor = Color.TRANSPARENT
            setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        dialog.show()
        scrim.fadeIn()
        sheet.post { sheet.translationY = sheet.height.toFloat(); sheet.animate().translationY(0f).setDuration(200).start() }
        return dialog
    }
}
