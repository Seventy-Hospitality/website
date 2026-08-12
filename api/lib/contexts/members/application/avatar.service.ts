import type { MemberService } from './member.service';
import type { MemberAvatarStore, UploadedImage } from './ports';

/**
 * Avatar workflow: upload through the media pipeline, point the member at
 * the new asset, attach it, drop the replaced one. Initials fallback is a
 * CLIENT rendering concern: avatarUrl simply stays null until a photo is
 * uploaded.
 */
export class MemberAvatarService {
  constructor(
    private readonly members: MemberService,
    private readonly store: MemberAvatarStore,
  ) {}

  async updateAvatar(memberId: string, upload: UploadedImage): Promise<{ avatarUrl: string }> {
    const { publicUrl } = await this.store.uploadAvatar(upload);
    const { previousAvatarUrl } = await this.members.setAvatar(memberId, publicUrl);
    await this.store.attachToMember(publicUrl, memberId);
    if (previousAvatarUrl && previousAvatarUrl !== publicUrl) {
      await this.store.deleteAvatar(previousAvatarUrl);
    }
    return { avatarUrl: publicUrl };
  }

  async removeAvatar(memberId: string): Promise<void> {
    const { previousAvatarUrl } = await this.members.setAvatar(memberId, null);
    await this.store.deleteAvatar(previousAvatarUrl);
  }
}
