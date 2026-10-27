import home from "../../assets/help/home-mobile.webp";
import cpu from "../../assets/help/cpu-settings-mobile.webp";
import invite from "../../assets/help/invite-mobile.webp";
import ready from "../../assets/help/room-ready-mobile.webp";
import publicRooms from "../../assets/help/public-rooms-mobile.webp";
import roomTabs from "../../assets/help/room-tabs-mobile.webp";
import records from "../../assets/help/account-records-mobile.webp";
import tournament from "../../assets/help/tournament-mobile.webp";
import settings from "../../assets/help/browser-settings-mobile.webp";
import desktopNavigation from "../../assets/help/navigation-desktop.webp";
import desktopRoom from "../../assets/help/room-desktop.webp";

export const helpScreenshots = {
  home: { src: home, width: 780, height: 1688 },
  cpu: { src: cpu, width: 716, height: 1624 },
  invite: { src: invite, width: 716, height: 712 },
  ready: { src: ready, width: 780, height: 1688 },
  publicRooms: { src: publicRooms, width: 700, height: 712 },
  roomTabs: { src: roomTabs, width: 780, height: 1688 },
  records: { src: records, width: 668, height: 522 },
  tournament: { src: tournament, width: 716, height: 1196 },
  settings: { src: settings, width: 716, height: 576 },
  desktopNavigation: { src: desktopNavigation, width: 1280, height: 69 },
  desktopRoom: { src: desktopRoom, width: 1280, height: 900 },
} as const;
