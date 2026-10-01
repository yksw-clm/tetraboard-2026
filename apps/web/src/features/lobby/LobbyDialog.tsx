import "../../shared/dialog.css";
import { Modal } from "@heroui/react";
import { type ReactNode } from "react";
import { LobbyIcon } from "./LobbyIcon";

export function LobbyDialog({
  title,
  busy = false,
  onClose,
  children,
}: {
  title: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal.Backdrop
      className="four-reversi-lobby lobby-modal app-modal"
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Modal.Container placement="center" size="lg">
        <Modal.Dialog className="lobby-dialog app-dialog" aria-busy={busy}>
          <Modal.Header className="lobby-dialog-heading app-dialog-heading">
            <Modal.Heading>{title}</Modal.Heading>
            <Modal.CloseTrigger className="app-dialog-close" aria-label="閉じる" isDisabled={busy}>
              <LobbyIcon name="close" />
            </Modal.CloseTrigger>
          </Modal.Header>
          <Modal.Body>{children}</Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
