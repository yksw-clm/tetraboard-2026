import { Component, type ReactNode } from "react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
export class AdminPageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <Card className="gap-4 p-6">
        <h1 className="text-xl font-semibold">画面を表示できませんでした</h1>
        <p role="alert">ページを再読み込みしてください。ほかの管理メニューも利用できます。</p>
        <Button className="self-start" onClick={() => window.location.reload()}>
          再読み込み
        </Button>
      </Card>
    ) : (
      this.props.children
    );
  }
}
