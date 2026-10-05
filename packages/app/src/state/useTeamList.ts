import { useEffect } from "react";
import type { CoordCommands } from "./commands.coord";
import { useLoadStatus } from "./loadStatus";

/** Screen-owned lifetime, shared status and one synchronous reconnect subscription. */
export function useTeamList(coord: CoordCommands) {
  const status = useLoadStatus(coord.teamsStatus);
  useEffect(() => coord.watchTeams(), [coord]);
  return status;
}
