import { useEffect, useRef, useState } from "react";
import { deleteAccount, updateAvatar } from "../api/auth";
import { assertPickableImage, ImageRejected } from "../images";
import { AvatarCropModal } from "./AvatarCropModal";
import { ChangePasswordModal } from "./ChangePasswordModal";
import { DeleteAccountModal } from "./DeleteAccountModal";
import { SettingsModal } from "./SettingsModal";
import { GearIcon } from "./icons";
import { Avatar, FieldError } from "./ui";
import type { User } from "../types";

type ProfileAvatarProps = {
  user: User;
  onAvatarChange: (user: User) => void;
  /** Rejects when the server didn't end the session, so this screen can say so. */
  onLogout: () => Promise<void>;
  onAccountDeleted: () => void;
};

export function ProfileAvatar({ user, onAvatarChange, onLogout, onAccountDeleted }: ProfileAvatarProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickedImageUrl, setPickedImageUrl] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so picking the same file twice still fires a change event.
    e.target.value = "";
    // Cancelling the OS picker lands here with nothing. Settings is closed on
    // *this* branch rather than when the picker opens, so backing out of the
    // file dialog returns to the sheet the user was in instead of dumping them
    // on the profile with no explanation of where it went.
    if (!file) return;
    setShowSettings(false);

    setError(null);
    // `accept="image/*"` only filters the picker's own listing; a 400MB video
    // or a decompression bomb still arrives here if the user switches the
    // dialog to "All files". Checked before the object URL exists, so the
    // cropper is never handed something it can't survive decoding.
    try {
      assertPickableImage(file);
    } catch (err) {
      setError(err instanceof ImageRejected ? err.message : "Couldn't read that photo.");
      return;
    }
    setPickedImageUrl(URL.createObjectURL(file));
  }

  /**
   * Closing the cropper is not the only way it goes away: a session that ends
   * mid-crop unmounts this whole tree (see the sign-out listener in App), and
   * the object URL would then be held for the life of the document. Tying the
   * revoke to the URL's own lifetime covers both exits with one rule.
   */
  useEffect(() => {
    if (!pickedImageUrl) return;
    return () => URL.revokeObjectURL(pickedImageUrl);
  }, [pickedImageUrl]);

  function closeCropper() {
    setPickedImageUrl(null);
  }

  async function handleCropConfirm(photo: string) {
    closeCropper();
    setUploading(true);
    try {
      const updated = await updateAvatar(photo);
      onAvatarChange(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update your photo.");
    } finally {
      setUploading(false);
    }
  }

  function handleEditPhoto() {
    fileInputRef.current?.click();
  }

  /**
   * The settings dialog stays open until the server confirms the session is
   * gone. Signing out locally on a failed call is what left a live `sid` row
   * behind on a shared machine.
   */
  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setSettingsError(null);
    try {
      await onLogout();
    } catch (err) {
      setSettingsError(
        err instanceof Error ? err.message : "Couldn't log out. Please try again.",
      );
    } finally {
      // On success this tree is already unmounted and the flag is moot; the
      // `finally` is for every other way out of the call.
      setLoggingOut(false);
    }
  }

  async function handleDeleteAccount(password: string) {
    await deleteAccount(password);
    onAccountDeleted();
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative h-24 w-24 shrink-0" aria-busy={uploading}>
        <Avatar url={user.avatarUrl} size="xl" />

        {/*
         * `uploading` was set but never rendered: the cropper closed, a
         * ~150KB upload went out, and the screen showed the old avatar with no
         * spinner, no dimming and no disabled control — so on a slow connection
         * the only available reading was "it didn't work", and people re-opened
         * the picker.
         */}
        {uploading && (
          <span
            className="absolute inset-0 flex items-center justify-center rounded-full bg-black/60"
            role="status"
          >
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            <span className="sr-only">Updating your photo…</span>
          </span>
        )}

        {/*
         * 44px of hit area around a 32px badge, the same negative-space trick
         * the close buttons use — the gear was the smallest target in the app.
         */}
        <button
          type="button"
          onClick={() => {
            setSettingsError(null);
            setNotice(null);
            setShowSettings(true);
          }}
          disabled={uploading}
          aria-label="Settings"
          className="absolute -bottom-1.5 -right-1.5 flex h-11 w-11 items-center justify-center disabled:cursor-not-allowed"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-black ring-2 ring-black transition-transform">
            <GearIcon className="h-4 w-4" />
          </span>
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        disabled={uploading}
        className="hidden"
      />

      {error && <FieldError message={error} />}
      {notice && (
        <p className="text-center text-xs text-neutral-300" role="status">
          {notice}
        </p>
      )}

      {pickedImageUrl && (
        <AvatarCropModal
          imageUrl={pickedImageUrl}
          onCancel={closeCropper}
          onConfirm={handleCropConfirm}
        />
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onEditPhoto={handleEditPhoto}
          onChangePassword={() => {
            setShowSettings(false);
            setShowChangePassword(true);
          }}
          onLogout={handleLogout}
          onDeleteAccount={() => {
            setShowSettings(false);
            setShowDeleteAccount(true);
          }}
          error={settingsError}
          loggingOut={loggingOut}
        />
      )}

      {showChangePassword && (
        <ChangePasswordModal
          onCancel={() => setShowChangePassword(false)}
          onChanged={() => {
            setShowChangePassword(false);
            setNotice("Password changed. Other devices have been signed out.");
          }}
        />
      )}

      {showDeleteAccount && (
        <DeleteAccountModal
          onCancel={() => setShowDeleteAccount(false)}
          onConfirm={handleDeleteAccount}
        />
      )}
    </div>
  );
}
