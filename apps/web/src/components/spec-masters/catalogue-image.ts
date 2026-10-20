// F-616 normalize an office upload before it crosses the API boundary. This
// deliberately removes EXIF and bounds pixels as well as compressed bytes.
export async function catalogueJpeg(file: File): Promise<string> {
  if (
    !["image/jpeg", "image/png"].includes(file.type) ||
    file.size > 8 * 1024 * 1024
  )
    throw new Error("Choose a JPEG or PNG up to 8 MiB.");
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 960 / image.width, 960 / image.height),
      canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    if (canvas.width < 32 || canvas.height < 32)
      throw new Error("Choose a clear image at least 32 pixels wide and high.");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser could not prepare the image.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) =>
            b ? resolve(b) : reject(new Error("Image could not be prepared.")),
          "image/jpeg",
          quality,
        ),
      );
      if (blob.size > 512 * 1024) continue;
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Image could not be read."));
        reader.onload = () =>
          typeof reader.result === "string"
            ? resolve(reader.result.slice(reader.result.indexOf(",") + 1))
            : reject(new Error("Image could not be read."));
        reader.readAsDataURL(blob);
      });
    }
    throw new Error(
      "This image is still too large. Choose a smaller, clearer product photo.",
    );
  } finally {
    image.close();
  }
}
