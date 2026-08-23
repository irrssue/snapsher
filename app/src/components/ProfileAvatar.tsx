import { useRef, useState } from "react";
import { updateAvatar } from "../api/auth";
import { readPhotoAsDataUrl } from "../api/posts";
import { PencilIcon, PersonIcon } from "./icons";
import type { User } from "../types";

type ProfileAvatarProps = {
  user: User;
  onAvatarChange: (user: User) => void;
};

export function ProfileAvatar({ user, onAvatarChange }: ProfileAvatarProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so picking the same file twice still fires a change event.
    e.target.value = "";
    if (!file) return;

    setError(null);
    setUploading(true);
    try {
      const photo = await readPhotoAsDataUrl(file);
      const updated = await updateAvatar(photo);
      onAvatarChange(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update your photo.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        aria-label={user.avatarUrl ? "Change profile photo" : "Add a profile photo"}
        className="group relative h-24 w-24 shrink-0 rounded-full disabled:opacity-70"
      >
        <span className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-neutral-300">
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <PersonIcon className="h-14 w-14 text-neutral-500" />
          )}
        </span>

        <span className="absolute bottom-0 right-0 flex h-8 w-8 items-center justify-center rounded-full bg-white text-black ring-2 ring-black transition-transform group-hover:scale-105">
          <PencilIcon className="h-3.5 w-3.5" />
        </span>
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
      />

      {error && <p className="text-center text-xs text-red-400">{error}</p>}
    </div>
  );
}
