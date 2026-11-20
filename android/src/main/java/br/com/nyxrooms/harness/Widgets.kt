package br.com.nyxrooms.harness

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Matrix
import android.graphics.RectF
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Bottom-sheet body that follows the finger: dragging down on the grabber/title, or on the
 * content while it is scrolled to the top, moves the sheet; releasing past 25% of its height
 * (or with a fast fling) closes it, otherwise it springs back.
 */
@SuppressLint("ViewConstructor")
class DragSheet(context: Context, private val maxHeightFraction: Float, private val onClose: () -> Unit) : LinearLayout(context) {
    var scroll: ScrollView? = null
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var downY = 0f
    private var downX = 0f
    private var dragging = false
    private var tracker: VelocityTracker? = null

    init { orientation = VERTICAL; isClickable = true }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val cap = (resources.displayMetrics.heightPixels * maxHeightFraction).toInt()
        super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(min(cap, MeasureSpec.getSize(heightMeasureSpec).takeIf { it > 0 } ?: cap), MeasureSpec.AT_MOST))
    }

    private fun track(event: MotionEvent) {
        val copy = MotionEvent.obtain(event)
        copy.setLocation(event.rawX, event.rawY)
        (tracker ?: VelocityTracker.obtain().also { tracker = it }).addMovement(copy)
        copy.recycle()
    }

    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { downY = event.rawY; downX = event.rawX; dragging = false; tracker?.recycle(); tracker = null; track(event) }
            MotionEvent.ACTION_MOVE -> {
                track(event)
                val dy = event.rawY - downY
                val atTop = scroll?.canScrollVertically(-1) != true
                if (dy > slop && abs(dy) > abs(event.rawX - downX) && atTop) { dragging = true; downY = event.rawY; parent?.requestDisallowInterceptTouchEvent(true); return true }
            }
        }
        return false
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        track(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { downY = event.rawY; dragging = true; return true }
            MotionEvent.ACTION_MOVE -> { if (dragging) translationY = max(0f, event.rawY - downY); return true }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                val velocity = tracker?.let { it.computeCurrentVelocity(1000); it.yVelocity } ?: 0f
                tracker?.recycle(); tracker = null
                if (dragging && (translationY > height * 0.25f || (velocity > 1400 && translationY > 0))) close()
                else animate().translationY(0f).setDuration(160).start()
                dragging = false
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    fun close() = animate().translationY(height.toFloat().coerceAtLeast(1f)).setDuration(170).withEndAction { onClose() }.start()
}

/** Image view with pinch zoom, drag, double tap to zoom/reset and a single-tap callback. */
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class ZoomImageView(context: Context, private val onTap: () -> Unit) : ImageView(context) {
    private val base = Matrix()
    private val current = Matrix()
    private var scale = 1f
    private val scaler = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            val next = (scale * detector.scaleFactor).coerceIn(1f, 6f)
            val factor = next / scale
            scale = next
            current.postScale(factor, factor, detector.focusX, detector.focusY)
            clamp(); imageMatrix = current
            return true
        }
    })
    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onSingleTapConfirmed(e: MotionEvent): Boolean { onTap(); return true }
        override fun onDoubleTap(e: MotionEvent): Boolean {
            if (scale > 1.05f) reset() else { scale = 2.5f; current.postScale(2.5f, 2.5f, e.x, e.y); clamp(); imageMatrix = current }
            return true
        }
        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
            if (scale <= 1.01f) return false
            current.postTranslate(-dx, -dy); clamp(); imageMatrix = current
            return true
        }
    })

    init { scaleType = ScaleType.MATRIX }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { super.onSizeChanged(w, h, oldw, oldh); reset() }
    override fun setImageBitmap(bm: android.graphics.Bitmap?) { super.setImageBitmap(bm); post { reset() } }

    fun reset() {
        val d = drawable ?: return
        if (width == 0 || height == 0) return
        base.setRectToRect(RectF(0f, 0f, d.intrinsicWidth.toFloat(), d.intrinsicHeight.toFloat()), RectF(0f, 0f, width.toFloat(), height.toFloat()), Matrix.ScaleToFit.CENTER)
        current.set(base); scale = 1f; imageMatrix = current
    }

    private fun clamp() {
        val d = drawable ?: return
        val rect = RectF(0f, 0f, d.intrinsicWidth.toFloat(), d.intrinsicHeight.toFloat())
        current.mapRect(rect)
        val dx = when { rect.width() <= width -> (width - rect.width()) / 2 - rect.left; rect.left > 0 -> -rect.left; rect.right < width -> width - rect.right; else -> 0f }
        val dy = when { rect.height() <= height -> (height - rect.height()) / 2 - rect.top; rect.top > 0 -> -rect.top; rect.bottom < height -> height - rect.bottom; else -> 0f }
        current.postTranslate(dx, dy)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaler.onTouchEvent(event)
        gestures.onTouchEvent(event)
        if (scale > 1.01f) parent?.requestDisallowInterceptTouchEvent(true)
        return true
    }

    val zoomed get() = scale > 1.01f
}

fun View.fadeIn() { alpha = 0f; animate().alpha(1f).setDuration(160).start() }
