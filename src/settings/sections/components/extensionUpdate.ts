import { toast } from "@/components/ui/toast";
import type { InstalledExtension } from "@/modules/extensions";

export async function checkSingleUpdate(
  ext: InstalledExtension,
  checkUpdate: (id: string) => Promise<{ has_update: boolean; latest_version: string | null }>,
): Promise<void> {
  if (!ext.source.startsWith("github:")) {
    toast(`${ext.manifest.name}: installed from a local .zip, so auto-update isn't available.`, {
      variant: "warning",
    });
    return;
  }
  try {
    const result = await checkUpdate(ext.id);
    if (result.has_update) {
      toast(`${ext.manifest.name}: v${result.latest_version} available`, {
        variant: "info",
      });
    } else {
      toast(`${ext.manifest.name} is up to date`, { variant: "success" });
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), { variant: "error" });
  }
}

export async function updateOne(
  ext: InstalledExtension,
  updateExtension: (id: string) => Promise<InstalledExtension>,
): Promise<void> {
  try {
    const next = await updateExtension(ext.id);
    toast(`${next.manifest.name} updated to v${next.manifest.version}`, {
      variant: "success",
    });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), { variant: "error" });
  }
}
