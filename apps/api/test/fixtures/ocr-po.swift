import AppKit
let bitmap = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:1400,pixelsHigh:1000,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep:bitmap)
NSColor.white.setFill(); NSRect(x:0,y:0,width:1400,height:1000).fill()
let attrs: [NSAttributedString.Key:Any] = [.font:NSFont.monospacedSystemFont(ofSize:36,weight:.regular),.foregroundColor:NSColor.black]
for (i,line) in ["PO-Number: SAMPLE-0580","Delivery-Date: 2026-10-24","SAMPLE-SKU PC 2 25.50"].enumerated() {
 (line as NSString).draw(at:NSPoint(x:80,y:820-i*100),withAttributes:attrs)
}
FileHandle.standardOutput.write(bitmap.representation(using:.png,properties:[:])!)
