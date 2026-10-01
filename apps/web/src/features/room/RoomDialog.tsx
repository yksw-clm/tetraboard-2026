import "../../shared/dialog.css";
import { Modal } from "@heroui/react";
import { type ReactNode } from "react";
import { RoomIcon } from "./RoomIcon";

export function RoomDialog({
  title,
  children,
  busy = false,
  onClose,
}: {
  title: string;
  children: ReactNode;
  busy?: boolean;
  onClose: () => void;
}) {
  return (
    <Modal.Backdrop
      className="four-reversi-room room-modal app-modal"
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Modal.Container placement="center" size="md">
        <Modal.Dialog className="room-dialog app-dialog" aria-busy={busy}>
          <Modal.Header className="room-dialog-heading app-dialog-heading">
            <Modal.Heading>{title}</Modal.Heading>
            <Modal.CloseTrigger className="app-dialog-close" isDisabled={busy} aria-label="閉じる">
              <RoomIcon name="close" />
            </Modal.CloseTrigger>
          </Modal.Header>
          <Modal.Body>{children}</Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
