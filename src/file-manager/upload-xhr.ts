import { FM_API } from "./paths";

export function uploadSingleFile(
  file: File,
  dirPath: string,
  onProgress: (ratio: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${FM_API}/upload`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(e.loaded / e.total);
      } else {
        onProgress(0);
      }
    };
    xhr.onerror = () => reject(new Error("Сеть недоступна"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
        return;
      }
      let msg = `Ошибка ${xhr.status}`;
      try {
        const j = JSON.parse(xhr.responseText) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      reject(new Error(msg));
    };
    const fd = new FormData();
    fd.set("path", dirPath);
    fd.append("files", file);
    xhr.send(fd);
  });
}
