package com.sunpride.van.printing

sealed interface ReceiptCommand {
    data class Line(val text: String, val style: ReceiptStyle = ReceiptStyle()) : ReceiptCommand
    data class Qr(val value: ReceiptElement.Qr) : ReceiptCommand
    data class Barcode(val value: ReceiptElement.Barcode) : ReceiptCommand
    data class Feed(val lines: Int) : ReceiptCommand
}

/** 58mm / 384 dots, 32 normal-width character cells (16 double-width).
 * Counts Unicode code points, not UTF-16 halves. Wide CJK/emoji glyph widths are not guaranteed
 * by thermal firmware; production amounts use ASCII P. Explicit newlines are preserved.
 */
class ReceiptLayoutFormatter(val columns: Int = 32) {
    init { require(columns >= 4) }

    fun format(document: ReceiptDocument): List<ReceiptCommand> = buildList {
        if (document.isReprint) add(ReceiptCommand.Line("REPRINT", ReceiptStyle(ReceiptAlignment.CENTER, bold = true)))
        document.elements.forEach { element ->
            when (element) {
                is ReceiptElement.Text -> wrap(element.text, if (element.style.doubleWidth) columns / 2 else columns)
                    .forEach { add(ReceiptCommand.Line(it, element.style)) }
                is ReceiptElement.Columns -> columnLines(element.label, element.value).forEach {
                    add(ReceiptCommand.Line(it, ReceiptStyle(bold = element.bold)))
                }
                is ReceiptElement.Divider -> add(ReceiptCommand.Line(element.character.toString().repeat(columns)))
                is ReceiptElement.Qr -> add(ReceiptCommand.Qr(element))
                is ReceiptElement.Barcode -> add(ReceiptCommand.Barcode(element))
                is ReceiptElement.Feed -> add(ReceiptCommand.Feed(element.lines))
            }
        }
    }

    /** Prefer word boundaries; even a single oversized word is split without losing a character. */
    fun wrap(text: String, width: Int = columns): List<String> {
        require(width > 0)
        return text.replace("\r\n", "\n").replace('\r', '\n').split('\n').flatMap { paragraph ->
            val points = paragraph.codePoints().toArray()
            val lines = mutableListOf<String>()
            var start = 0
            while (points.size - start > width) {
                val end = start + width
                val space = (start until end).lastOrNull { points[it] == ' '.code }
                val split = if (space != null && space > start) space + 1 else end
                lines += String(points, start, split - start)
                start = split
            }
            lines += String(points, start, points.size - start)
            lines
        }
    }

    fun columnLines(label: String, value: String): List<String> {
        val valueWidth = value.codePointCount(0, value.length)
        // Very long amounts or multiline values get their own right-aligned lines, not cropped.
        if (valueWidth >= columns - 1 || value.contains('\n') || value.contains('\r')) {
            return wrap(label) + wrap(value).map { " ".repeat(columns - it.codePointCount(0, it.length)) + it }
        }
        val labels = wrap(label, columns - valueWidth - 1)
        return labels.mapIndexed { index, line ->
            if (index == labels.lastIndex) line + " ".repeat(columns - line.codePointCount(0, line.length) - valueWidth) + value
            else line
        }
    }
}
