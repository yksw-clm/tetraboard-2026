import { Card, cn } from "@heroui/react";
import { type ComponentPropsWithRef } from "react";

export function AppCard({
  className,
  density = "default",
  ...props
}: ComponentPropsWithRef<typeof Card> & { density?: "default" | "compact" }) {
  return (
    <Card
      {...props}
      className={cn(
        "rounded-panel border border-solid border-line bg-white text-ink shadow-panel",
        density === "compact" ? "py-[10px] px-[14px] gap-2 [@media(max-width:767px)]:px-3" : "p-5",
        className,
      )}
    />
  );
}

AppCard.Header = Card.Header;
AppCard.Title = Card.Title;
AppCard.Description = Card.Description;
AppCard.Content = Card.Content;
AppCard.Footer = Card.Footer;
