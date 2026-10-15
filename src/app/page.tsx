import { Hero } from "@/components/landing/Hero";
import { About } from "@/components/landing/About";
import { ProductLines } from "@/components/landing/ProductLines";
import { Contact } from "@/components/landing/Contact";

export default function HomePage() {
  return (
    <>
      <Hero />
      <About />
      <ProductLines />
      <Contact />
    </>
  );
}
