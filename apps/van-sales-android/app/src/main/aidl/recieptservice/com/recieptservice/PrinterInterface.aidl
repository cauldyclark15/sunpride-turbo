// Senraise H10P built-in printer service (system app recieptservice.com.recieptservice,
// /system/priv-app/SRPrinter). Recovered from PrinterInterface$Stub$Proxy in SRPrinter.apk
// (classes3.dex) with dexdump: AIDL assigns transaction codes by declaration order, so the
// order below MUST match the vendor's codes 1..21 exactly. The vendor's PSAM-card methods
// (codes 22..25) are intentionally omitted; trailing omissions do not shift earlier codes.
package recieptservice.com.recieptservice;

import android.graphics.Bitmap;

interface PrinterInterface {
    void printEpson(in byte[] data);                                       // 1
    String getServiceVersion();                                           // 2
    void printText(String text);                                          // 3
    void printBitmap(in Bitmap bitmap);                                   // 4
    void printBarCode(String data, int symbology, int height, int width); // 5
    void printQRCode(String data, int moduleSize, int errorLevel);       // 6
    void setAlignment(int alignment);                                     // 7  0=left 1=center 2=right
    void setTextSize(float size);                                         // 8
    void nextLine(int lines);                                             // 9
    void printTableText(in String[] text, in int[] weight, in int[] alignment); // 10
    void setTextBold(boolean bold);                                       // 11
    void beginWork();                                                     // 12
    void endWork();                                                       // 13
    void setDark(int level);                                              // 14
    void setLineHeight(float height);                                     // 15
    void setTextDoubleWidth(boolean enable);                              // 16
    void setTextDoubleHeight(boolean enable);                             // 17
    void printPDF417Code(String data, int width, int height);            // 18
    void setCode(String charset);                                         // 19
    void print128BarCode(String data, int type, int height, int width); // 20 vendor encoder type (not reordered)
    boolean getScannerStatus();                                           // 21
}
