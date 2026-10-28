import { copyFile, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StudyDocument } from "../shared/model";
import { parseStudyDocument, StudyInputError, validateStudyId } from "./study";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function syncedWrite(path: string, contents: string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

export class StudyStore {
  readonly directory: string;
  readonly recoveries: { studyId: string; message: string }[] = [];
  readonly errors: { studyId: string; message: string }[] = [];
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const before = this.pending.get(id) ?? Promise.resolve();
    const next = before.catch(() => {}).then(action);
    this.pending.set(id, next);
    try {
      return await next;
    } finally {
      if (this.pending.get(id) === next) this.pending.delete(id);
    }
  }
  private path(id: string) {
    return join(this.directory, `${validateStudyId(id)}.json`);
  }
  private async read(path: string, id: string): Promise<StudyDocument> {
    const study = await parseStudyDocument(JSON.parse(await readFile(path, "utf8")));
    if (study.id !== id) throw new StudyInputError("保存ファイル名と検討IDが一致しません");
    return study;
  }
  private async readWithRecovery(id: string): Promise<StudyDocument | null> {
    const path = this.path(id);
    let primaryError: unknown;
    try {
      return await this.read(path, id);
    } catch (error) {
      primaryError = error;
    }
    let backup: StudyDocument;
    try {
      backup = await this.read(`${path}.bak`, id);
    } catch (error) {
      if (missing(primaryError) && missing(error)) return null;
      throw new StudyInputError(`検討ファイルとバックアップを読み込めません: ${id}`);
    }
    const recoveryPath = `${path}.${crypto.randomUUID()}.tmp`;
    await syncedWrite(recoveryPath, JSON.stringify(backup, null, 2));
    try {
      if (!missing(primaryError))
        await rename(path, `${path}.corrupt-${Date.now()}-${crypto.randomUUID()}`);
      await rename(recoveryPath, path);
    } finally {
      await unlink(recoveryPath).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
    this.recoveries.push({
      studyId: id,
      message: "前回の保存バックアップから検討を復元しました。",
    });
    return backup;
  }
  async load(id: string): Promise<StudyDocument | null> {
    validateStudyId(id);
    return this.serial(id, () => this.readWithRecovery(id));
  }
  async list(): Promise<StudyDocument[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = await readdir(this.directory);
    const ids = new Set(
      files.flatMap((name) => {
        const match = /^([a-zA-Z0-9_-]{1,100})\.json(?:\.bak)?$/.exec(name);
        return match ? [match[1]] : [];
      }),
    );
    this.errors.length = 0;
    const studies = await Promise.all(
      [...ids].map(async (id) => {
        try {
          return await this.load(id);
        } catch (error) {
          this.errors.push({
            studyId: id,
            message: error instanceof Error ? error.message : "検討ファイルを読み込めません",
          });
          return null;
        }
      }),
    );
    return studies
      .filter((study): study is StudyDocument => study !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async save(input: StudyDocument, expectedRevision?: number | null): Promise<void> {
    const study = await parseStudyDocument(input);
    await this.serial(study.id, async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const previous = await this.readWithRecovery(study.id);
      if (
        expectedRevision === null
          ? previous !== null
          : expectedRevision !== undefined && previous?.revision !== expectedRevision
      )
        throw new StudyInputError("別の操作で検討が更新されました。読み直してください");
      if (previous && study.revision <= previous.revision)
        throw new StudyInputError("古い更新番号の検討は保存できません");
      if (!previous && study.revision !== 0)
        throw new StudyInputError("新しい検討の更新番号は0です");
      const path = this.path(study.id);
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      const backupTemporary = `${path}.${crypto.randomUUID()}.bak.tmp`;
      try {
        await syncedWrite(temporary, `${JSON.stringify(study, null, 2)}\n`);
        if (previous) {
          await copyFile(path, backupTemporary);
          const backup = await open(backupTemporary, "r");
          try {
            await backup.sync();
          } finally {
            await backup.close();
          }
          await rename(backupTemporary, `${path}.bak`);
        }
        await rename(temporary, path);
        const directory = await open(this.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        for (const file of [temporary, backupTemporary])
          await unlink(file).catch((error) => {
            if (!missing(error)) throw error;
          });
      }
    });
  }
}
