import { Card, cn } from "@heroui/react";
import { type ComponentPropsWithRef } from "react";

export function AppCard({ className, ...props }: ComponentPropsWithRef<typeof Card>) {
  return (
    <Card
      {...props}
      className={cn(
        "rounded-panel border border-solid border-line bg-white p-5 text-ink shadow-panel",
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
