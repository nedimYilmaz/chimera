import { createRoot } from "react-dom/client";
import { OperatorPanel } from "./OperatorPanel";
import { createOperatorTransport } from "./bridge";
import "../styles/tokens.css";
import "../styles/base.css";
createRoot(document.getElementById("root")!).render(<OperatorPanel transport={createOperatorTransport()} />);
