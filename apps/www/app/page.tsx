import { Demo } from "./components/demo";
import { Hero } from "./components/hero";
import { Safety } from "./components/safety";
import { Setup } from "./components/setup";

const Home = () => (
  <main>
    <Hero />
    <Demo />
    <Setup />
    <Safety />
  </main>
);

export default Home;
