import { useCallback, useState } from "react";
import {
  ChevronDown,
  ChevronsUpDown,
  Clock3,
  FileText,
  Inbox,
  Mail,
  PanelLeft,
  Pencil,
  RefreshCw,
  Send,
  Settings,
  ShieldAlert,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import type { AccountInfo, FolderInfo, MailboxView } from "../../shared/contracts";
import { KEYBOARD_SHORTCUTS } from "../shortcuts";
import { IconButton, MenuButton } from "./Controls";
import { OverlayScrollbar } from "./OverlayScrollbar";

interface SidebarProps {
  accounts: AccountInfo[];
  folders: FolderInfo[];
  accountId?: string;
  activeView: MailboxView;
  activeLabel?: string;
  unreadCount: number;
  draftCount: number;
  scheduledCount: number;
  collapsed: boolean;
  updateReady: boolean;
  onAccountChange(value?: string): void;
  onViewChange(view: MailboxView, label?: string): void;
  onCompose(): void;
  onSettings(): void;
  onInstallUpdate(): void;
  onToggleCollapsed(): void;
}

const SYSTEM_ITEMS: Array<{
  view: MailboxView;
  label: string;
  icon: typeof Inbox;
}> = [
  { view: "inbox", label: "Inbox", icon: Inbox },
  { view: "starred", label: "Starred", icon: Star },
  { view: "sent", label: "Sent", icon: Send },
  { view: "drafts", label: "Drafts", icon: FileText },
  { view: "scheduled", label: "Scheduled", icon: Clock3 },
  { view: "all", label: "All mail", icon: Mail },
  { view: "spam", label: "Spam", icon: ShieldAlert },
  { view: "trash", label: "Trash", icon: Trash2 },
];

export function Sidebar(props: SidebarProps) {
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const handleScrollerRef = useCallback((element: HTMLElement | null) => {
    setScroller(element);
  }, []);
  const selectedAccount = props.accounts.find((account) => account.id === props.accountId);
  const customLabels = uniqueLabels(
    props.folders.filter(
      (folder) => !folder.role && (!props.accountId || folder.accountId === props.accountId),
    ),
  );
  return (
    <aside className={`sidebar ${props.collapsed ? "collapsed" : ""}`}>
      <div className="sidebar-titlebar">
        <IconButton
          label="Collapse sidebar"
          className="sidebar-footer-button"
          tooltipSide="bottom"
          shortcut={KEYBOARD_SHORTCUTS.toggleSidebar}
          onClick={props.onToggleCollapsed}
        >
          <PanelLeft size={17} />
        </IconButton>
        <IconButton
          label="Compose"
          className="icon-button sidebar-compose-button"
          tooltipSide="bottom"
          shortcut={KEYBOARD_SHORTCUTS.compose}
          onClick={props.onCompose}
        >
          <Pencil size={16} />
        </IconButton>
      </div>
      {!props.collapsed ? (
        <MenuButton
          label="Choose account"
          className="account-picker"
          triggerClassName="account-picker-trigger"
          menuClassName="account-menu"
          tooltip={false}
          options={[
            {
              id: "all",
              label: "All accounts",
              selected: !props.accountId,
              onSelect: () => props.onAccountChange(undefined),
            },
            ...props.accounts.map((account) => ({
              id: account.id,
              label: account.email,
              selected: account.id === props.accountId,
              onSelect: () => props.onAccountChange(account.id),
            })),
          ]}
        >
          <span className="truncate">{selectedAccount?.email ?? "All accounts"}</span>
          <ChevronsUpDown size={14} />
        </MenuButton>
      ) : null}
      <div className="sidebar-nav-wrap">
        <nav ref={handleScrollerRef} className="sidebar-nav" aria-label="Mailboxes">
          {SYSTEM_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = props.activeView === item.view;
            return (
              <button
                key={item.view}
                className={`nav-item ${active ? "active" : ""}`}
                onClick={() => props.onViewChange(item.view)}
              >
                <Icon size={17} strokeWidth={1.8} />
                <span className="nav-label">{item.label}</span>
                {item.view === "inbox" && props.unreadCount > 0 ? (
                  <span className="nav-count">{props.unreadCount}</span>
                ) : null}
                {item.view === "drafts" && props.draftCount > 0 ? (
                  <span className="nav-count">{props.draftCount}</span>
                ) : null}
                {item.view === "scheduled" && props.scheduledCount > 0 ? (
                  <span className="nav-count">{props.scheduledCount}</span>
                ) : null}
              </button>
            );
          })}
          {customLabels.length && !props.collapsed ? (
            <button
              className="nav-section-title labels-toggle"
              onClick={() => setLabelsOpen((open) => !open)}
              aria-expanded={labelsOpen}
            >
              <span>Labels</span>
              <ChevronDown className={labelsOpen ? "" : "collapsed"} size={13} />
            </button>
          ) : null}
          {labelsOpen && !props.collapsed
            ? customLabels.map((label) => (
                <button
                  key={label}
                  className={`nav-item ${props.activeView === "label" && props.activeLabel === label ? "active" : ""}`}
                  onClick={() => props.onViewChange("label", label)}
                >
                  <Tag size={16} strokeWidth={1.8} />
                  <span className="truncate">{label}</span>
                </button>
              ))
            : null}
        </nav>
        <OverlayScrollbar scroller={scroller} fadeClass="sidebar-fade" />
      </div>
      <div className="sidebar-footer">
        {props.updateReady ? (
          <button type="button" className="sidebar-update-button" onClick={props.onInstallUpdate}>
            <RefreshCw size={14} />
            Restart to update
          </button>
        ) : null}
        <IconButton
          label="Settings"
          className="sidebar-footer-button"
          tooltipSide={props.collapsed ? "right" : "top"}
          onClick={props.onSettings}
        >
          <Settings size={17} />
        </IconButton>
      </div>
    </aside>
  );
}

function uniqueLabels(folders: FolderInfo[]): string[] {
  return [...new Set(folders.map((folder) => folder.name))].sort((left, right) =>
    left.localeCompare(right),
  );
}
