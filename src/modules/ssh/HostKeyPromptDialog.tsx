import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHostKeyPrompt } from "./hostKeyPrompt";

/**
 * Blocking confirmation for a NEW SSH host key (trust-on-first-use). The
 * backend pauses the handshake BEFORE sending credentials and emits a prompt;
 * the user must verify the fingerprint out-of-band and accept, or reject to
 * abort. Deliberately not dismissable without a decision (no close button,
 * Escape and click-outside disabled) so credentials are never sent to an
 * unverified host by accident. Mounted once at the app root.
 */
export function HostKeyPromptDialog() {
  const queue = useHostKeyPrompt((s) => s.queue);
  const resolve = useHostKeyPrompt((s) => s.resolve);
  const current = queue[0];

  return (
    <Dialog open={current != null} onOpenChange={() => {}}>
      {current && (
        <DialogContent
          showCloseButton={false}
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="sm:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>Verify SSH host key</DialogTitle>
            <DialogDescription>
              First connection to{" "}
              <span className="text-foreground font-medium">{current.host}</span>. Confirm this
              fingerprint matches the server's real key by checking it out-of-band: ask the admin,
              or run <code className="text-foreground">ssh-keygen -lf &lt;hostkey&gt;</code> on the
              server. Trusting an attacker's key on first connect hands them your credentials. Once
              trusted, this host is not asked about again.
            </DialogDescription>
          </DialogHeader>
          <div className="bg-muted text-foreground rounded-md p-2.5 font-mono text-xs break-all select-all">
            {current.fingerprint}
          </div>
          {/* Two-column full-width footer to match the app's other
              confirmation modals (AlertDialogFooter's `grid grid-cols-2`):
              Reject + Trust split the row into equal columns that fill the
              dialog width, instead of clustering on the right. */}
          <DialogFooter className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => resolve(current.promptId, false)}>
              Reject
            </Button>
            <Button onClick={() => resolve(current.promptId, true)}>Trust &amp; connect</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
