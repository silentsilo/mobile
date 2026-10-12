package com.silentsilo.mobile

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import java.io.ByteArrayOutputStream
import java.io.File

// PDF pages drawn by Android's own renderer, from a decrypted copy in the
// silo's scratch directory, which every lock wipes. Called from Rust.
object PdfPages {
  // The most pixels one drawn page may have, about 48 MB as a bitmap: a page
  // a few points wide and miles tall would otherwise take all the memory.
  private const val MAX_PIXELS = 12_000_000L
  @JvmStatic
  fun count(path: String): Int =
    try {
      ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
        PdfRenderer(fd).use { it.pageCount }
      }
    } catch (_: Exception) {
      -1
    }

  // One page as a PNG `width` pixels wide, or null.
  @JvmStatic
  fun render(path: String, index: Int, width: Int): ByteArray? =
    try {
      ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
        PdfRenderer(fd).use { renderer ->
          renderer.openPage(index).use { page ->
            if (page.width <= 0 || page.height <= 0) {
              null
            } else {
              var w = width.coerceIn(200, 2400).toLong()
              var h = (w * page.height / page.width).coerceAtLeast(1)
              if (w * h > MAX_PIXELS) {
                val shrink = Math.sqrt(MAX_PIXELS.toDouble() / (w * h))
                w = (w * shrink).toLong().coerceAtLeast(1)
                h = (h * shrink).toLong().coerceAtLeast(1)
              }
              val bitmap = Bitmap.createBitmap(w.toInt(), h.toInt(), Bitmap.Config.ARGB_8888)
              bitmap.eraseColor(Color.WHITE)
              page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
              val out = ByteArrayOutputStream()
              bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
              bitmap.recycle()
              out.toByteArray()
            }
          }
        }
      }
    } catch (_: Exception) {
      null
    }
}
