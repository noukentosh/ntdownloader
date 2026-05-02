import { FileManagerApp } from "./file-manager/FileManagerApp";
import "./index.css";

export function App() {
  return (
    <div className="relative z-10 min-h-screen w-full">
      <FileManagerApp />
    </div>
  );
}

export default App;
