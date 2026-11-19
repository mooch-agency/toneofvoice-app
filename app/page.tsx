import Header from "@/components/Header"
import BrandBanner from "@/components/BrandBanner"
import HeroSection from "@/components/landing/hero-section"
import FeaturesSection from "@/components/landing/features-section"
import WhatsIncludedSection from "@/components/landing/whats-included-section"
import ComparisonSection from "@/components/landing/comparison-section"
import HowItWorksSection from "@/components/landing/how-it-works-section"
import ExampleSection from "@/components/landing/example-section"
import PricingSection from "@/components/landing/pricing-section"
import FaqSection from "@/components/landing/faq-section"
import TestimonialsSection from "@/components/testimonials-section"
import FinalCtaSection from "@/components/landing/final-cta-section"

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header showNavigation={true} showGetStarted={true} />
      <main className="flex-1">
        <HeroSection />
        <BrandBanner />
        <FeaturesSection />
        <WhatsIncludedSection />
        <ComparisonSection />
        <HowItWorksSection />
        <TestimonialsSection />
        <ExampleSection />
        <PricingSection />
        <FaqSection />
        <FinalCtaSection />
      </main>
    </div>
  )
}
