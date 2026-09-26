export async function uploadNoticePendingPhotos(
  noticeId: number,
  items: { blob: Blob }[],
  post: typeof fetch = fetch
): Promise<{ uploaded: number; failed: number }> {
  let uploaded = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i++) {
    const blob = items[i].blob;
    const mime = (blob.type || "image/jpeg").toLowerCase();
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    const fd = new FormData();
    fd.append("file", blob, `photo-${i}.${ext}`);
    const res = await post(`/api/notice/${noticeId}/photos`, {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    if (res.ok) uploaded += 1;
    else failed += 1;
  }
  return { uploaded, failed };
}
