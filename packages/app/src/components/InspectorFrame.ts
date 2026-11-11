import { createContext, useContext } from "react";

export const InspectorFrame = createContext(false);
export const useInspectorFrame = () => useContext(InspectorFrame);
