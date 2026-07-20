import { Features } from "./components/features";
import { Hero } from "./components/hero";
import { Install } from "./components/install";
import { Problem } from "./components/problem";
import { Walkthrough } from "./components/walkthrough";

const Home = () => (
  <main>
    <Hero />
    <Problem />
    <Install />
    <Walkthrough />
    <Features />
  </main>
);

export default Home;
