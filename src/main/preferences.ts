import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  appearancePreferenceSchema,
  undoSendDelaySecondsSchema,
  type AppearancePreference,
  type UndoSendDelaySeconds,
} from "../shared/contracts";

const preferencesFileSchema = z.discriminatedUnion("version", [
  z.strictObject({ version: z.literal(1), appearance: appearancePreferenceSchema }),
  z.strictObject({
    version: z.literal(2),
    appearance: appearancePreferenceSchema,
    dockBadge: z.boolean(),
  }),
  z.strictObject({
    version: z.literal(3),
    appearance: appearancePreferenceSchema,
    dockBadge: z.boolean(),
    blockRemoteImages: z.boolean(),
  }),
  z.strictObject({
    version: z.literal(4),
    appearance: appearancePreferenceSchema,
    dockBadge: z.boolean(),
    blockRemoteImages: z.boolean(),
    imageRelay: z.boolean(),
  }),
  z.strictObject({
    version: z.literal(5),
    appearance: appearancePreferenceSchema,
    dockBadge: z.boolean(),
    openNextAfterArchive: z.boolean().optional(),
    blockRemoteImages: z.boolean(),
    imageRelay: z.boolean(),
    undoSendDelaySeconds: undoSendDelaySecondsSchema.optional(),
  }),
  z.strictObject({
    version: z.literal(6),
    appearance: appearancePreferenceSchema,
    dockBadge: z.boolean(),
    openNextAfterArchive: z.boolean(),
    blockRemoteImages: z.boolean(),
    imageRelay: z.boolean(),
    undoSendDelaySeconds: undoSendDelaySecondsSchema,
  }),
]);

export class DesktopPreferences {
  private appearanceValue: AppearancePreference = "system";
  private dockBadgeValue = true;
  private openNextAfterArchiveValue = true;
  private blockRemoteImagesValue = true;
  private imageRelayValue = true;
  private undoSendDelaySecondsValue: UndoSendDelaySeconds = 10;
  private readonly filePath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(userDataDirectory: string) {
    this.filePath = path.join(userDataDirectory, "desktop-preferences.json");
  }

  async load(): Promise<AppearancePreference> {
    try {
      const stored = preferencesFileSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
      this.appearanceValue = stored.appearance;
      this.dockBadgeValue = stored.version === 1 ? true : stored.dockBadge;
      this.blockRemoteImagesValue =
        stored.version === 3 || stored.version === 4 || stored.version === 5 || stored.version === 6
          ? stored.blockRemoteImages
          : true;
      this.imageRelayValue =
        stored.version === 4 || stored.version === 5 || stored.version === 6
          ? stored.imageRelay
          : true;
      this.openNextAfterArchiveValue =
        stored.version === 5 || stored.version === 6 ? (stored.openNextAfterArchive ?? true) : true;
      this.undoSendDelaySecondsValue =
        stored.version === 5 || stored.version === 6 ? (stored.undoSendDelaySeconds ?? 10) : 10;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof z.ZodError) &&
        !(error instanceof SyntaxError)
      ) {
        throw error;
      }
      this.appearanceValue = "system";
      this.dockBadgeValue = true;
      this.openNextAfterArchiveValue = true;
      this.blockRemoteImagesValue = true;
      this.imageRelayValue = true;
      this.undoSendDelaySecondsValue = 10;
    }
    return this.appearanceValue;
  }

  appearance(): AppearancePreference {
    return this.appearanceValue;
  }

  dockBadge(): boolean {
    return this.dockBadgeValue;
  }

  openNextAfterArchive(): boolean {
    return this.openNextAfterArchiveValue;
  }

  blockRemoteImages(): boolean {
    return this.blockRemoteImagesValue;
  }

  imageRelay(): boolean {
    return this.imageRelayValue;
  }

  undoSendDelaySeconds(): UndoSendDelaySeconds {
    return this.undoSendDelaySecondsValue;
  }

  async setAppearance(appearance: AppearancePreference): Promise<AppearancePreference> {
    const value = appearancePreferenceSchema.parse(appearance);
    return this.enqueueMutation(async () => {
      await this.save(
        value,
        this.dockBadgeValue,
        this.openNextAfterArchiveValue,
        this.blockRemoteImagesValue,
        this.imageRelayValue,
        this.undoSendDelaySecondsValue,
      );
      this.appearanceValue = value;
      return value;
    });
  }

  async setDockBadge(enabled: boolean): Promise<boolean> {
    const value = z.boolean().parse(enabled);
    return this.enqueueMutation(async () => {
      await this.save(
        this.appearanceValue,
        value,
        this.openNextAfterArchiveValue,
        this.blockRemoteImagesValue,
        this.imageRelayValue,
        this.undoSendDelaySecondsValue,
      );
      this.dockBadgeValue = value;
      return value;
    });
  }

  async setOpenNextAfterArchive(enabled: boolean): Promise<boolean> {
    const value = z.boolean().parse(enabled);
    return this.enqueueMutation(async () => {
      await this.save(
        this.appearanceValue,
        this.dockBadgeValue,
        value,
        this.blockRemoteImagesValue,
        this.imageRelayValue,
        this.undoSendDelaySecondsValue,
      );
      this.openNextAfterArchiveValue = value;
      return value;
    });
  }

  async setBlockRemoteImages(enabled: boolean): Promise<boolean> {
    const value = z.boolean().parse(enabled);
    return this.enqueueMutation(async () => {
      await this.save(
        this.appearanceValue,
        this.dockBadgeValue,
        this.openNextAfterArchiveValue,
        value,
        this.imageRelayValue,
        this.undoSendDelaySecondsValue,
      );
      this.blockRemoteImagesValue = value;
      return value;
    });
  }

  async setImageRelay(enabled: boolean): Promise<boolean> {
    const value = z.boolean().parse(enabled);
    return this.enqueueMutation(async () => {
      await this.save(
        this.appearanceValue,
        this.dockBadgeValue,
        this.openNextAfterArchiveValue,
        this.blockRemoteImagesValue,
        value,
        this.undoSendDelaySecondsValue,
      );
      this.imageRelayValue = value;
      return value;
    });
  }

  async setUndoSendDelaySeconds(delay: UndoSendDelaySeconds): Promise<UndoSendDelaySeconds> {
    const value = undoSendDelaySecondsSchema.parse(delay);
    return this.enqueueMutation(async () => {
      await this.save(
        this.appearanceValue,
        this.dockBadgeValue,
        this.openNextAfterArchiveValue,
        this.blockRemoteImagesValue,
        this.imageRelayValue,
        value,
      );
      this.undoSendDelaySecondsValue = value;
      return value;
    });
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async save(
    appearance: AppearancePreference,
    dockBadge: boolean,
    openNextAfterArchive: boolean,
    blockRemoteImages: boolean,
    imageRelay: boolean,
    undoSendDelaySeconds: UndoSendDelaySeconds,
  ): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      temporaryPath,
      `${JSON.stringify({
        version: 6,
        appearance,
        dockBadge,
        openNextAfterArchive,
        blockRemoteImages,
        imageRelay,
        undoSendDelaySeconds,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}
