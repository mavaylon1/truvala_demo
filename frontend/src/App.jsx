import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";

function Icon({ name, size = 20, className = "" }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className,
    "aria-hidden": true,
  };

  const icons = {
    sun: (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2" />
        <path d="M12 20v2" />
        <path d="m4.93 4.93 1.41 1.41" />
        <path d="m17.66 17.66 1.41 1.41" />
        <path d="M2 12h2" />
        <path d="M20 12h2" />
        <path d="m6.34 17.66-1.41 1.41" />
        <path d="m19.07 4.93-1.41 1.41" />
      </svg>
    ),
    moon: (
      <svg {...common}>
        <path d="M21 12.79A9 9 0 1 1 11.21 3c0 .34 0 .67.05 1A7 7 0 0 0 20 12.74c.33.05.66.05 1 .05Z" />
      </svg>
    ),
    search: (
      <svg {...common}>
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    ),
    sliders: (
      <svg {...common}>
        <path d="M4 21v-7" />
        <path d="M4 10V3" />
        <path d="M12 21v-9" />
        <path d="M12 8V3" />
        <path d="M20 21v-5" />
        <path d="M20 12V3" />
        <path d="M2 14h4" />
        <path d="M10 8h4" />
        <path d="M18 16h4" />
      </svg>
    ),
    mapPin: (
      <svg {...common}>
        <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
        <circle cx="12" cy="10" r="3" />
      </svg>
    ),
    home: (
      <svg {...common}>
        <path d="m3 11 9-8 9 8" />
        <path d="M5 10v10h14V10" />
        <path d="M9 20v-6h6v6" />
      </svg>
    ),
    shield: (
      <svg {...common}>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
    ),
    trending: (
      <svg {...common}>
        <path d="m3 17 6-6 4 4 8-8" />
        <path d="M14 7h7v7" />
      </svg>
    ),
    wrench: (
      <svg {...common}>
        <path d="M14.7 6.3a4 4 0 0 0-5 5L3 18l3 3 6.7-6.7a4 4 0 0 0 5-5l-2.8 2.8-3-3Z" />
      </svg>
    ),
    sparkles: (
      <svg {...common}>
        <path d="M12 3 9.8 8.2 5 10.5l4.8 2.3L12 18l2.2-5.2 4.8-2.3-4.8-2.3Z" />
        <path d="M5 3v4" />
        <path d="M3 5h4" />
        <path d="M19 17v4" />
        <path d="M17 19h4" />
      </svg>
    ),
  };

  return icons[name] ?? null;
}

function Button({ children, className = "", ...props }) {
  return (
    <button
      className={`inline-flex items-center justify-center font-medium transition active:scale-[0.99] ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function Card({ children, className = "" }) {
  return <div className={className}>{children}</div>;
}

function CardContent({ children, className = "" }) {
  return <div className={className}>{children}</div>;
}

const listings = [
  {
    title: "Modern OC Family Home",
    location: "Irvine, CA",
    price: "$1.24M",
    score: 87,
    risk: "Low",
    note: "Strong resale area",
    gradient: "from-gray-100 to-gray-300",
    x: "8%",
    y: "18%",
    delay: 0,
  },
  {
    title: "Possible Flip Risk",
    location: "Anaheim, CA",
    price: "$895K",
    score: 62,
    risk: "High",
    note: "Recent cosmetic updates",
    gradient: "from-gray-200 to-gray-400",
    x: "72%",
    y: "12%",
    delay: 2.2,
  },
  {
    title: "Older Roof Candidate",
    location: "Orange, CA",
    price: "$980K",
    score: 71,
    risk: "Med",
    note: "Roof age signal",
    gradient: "from-gray-100 to-gray-400",
    x: "5%",
    y: "68%",
    delay: 4.1,
  },
  {
    title: "Investor Watchlist",
    location: "Costa Mesa, CA",
    price: "$1.08M",
    score: 79,
    risk: "Med",
    note: "Rent upside nearby",
    gradient: "from-gray-200 to-gray-300",
    x: "78%",
    y: "66%",
    delay: 1.4,
  },
  {
    title: "Avoid: Builder Match",
    location: "Menifee, CA",
    price: "$610K",
    score: 48,
    risk: "High",
    note: "Excluded builder flag",
    gradient: "from-gray-300 to-gray-500",
    x: "38%",
    y: "4%",
    delay: 6.0,
  },
  {
    title: "Quiet Street Find",
    location: "Tustin, CA",
    price: "$1.16M",
    score: 91,
    risk: "Low",
    note: "Low noise / good schools",
    gradient: "from-gray-100 to-gray-300",
    x: "44%",
    y: "77%",
    delay: 3.2,
  },
];

const featureCards = [
  { icon: "shield", label: "Risk score" },
  { icon: "wrench", label: "Repair flags" },
  { icon: "trending", label: "Resale signal" },
  { icon: "sliders", label: "Custom filters" },
];

function FloatingListing({ listing, index, theme }) {
  const isDark = theme === "dark";
  const path = useMemo(() => {
    const direction = index % 2 === 0 ? 1 : -1;
    return {
      x: [0, 38 * direction, 80 * direction, 28 * direction, -20 * direction, 0],
      y: [0, -18, 20, 54, 16, 0],
      rotate: [0, 1.6 * direction, -1.2 * direction, 2 * direction, -0.8 * direction, 0],
      scale: [0.92, 1, 1.05, 0.96, 0.9, 0.92],
      opacity: [0, 0.42, 0.78, 0.36, 0, 0],
      filter: ["blur(12px)", "blur(5px)", "blur(0px)", "blur(7px)", "blur(15px)", "blur(12px)"],
    };
  }, [index]);

  return (
    <motion.div
      className="absolute w-72"
      style={{ left: listing.x, top: listing.y }}
      animate={path}
      transition={{
        duration: 18 + index * 1.7,
        repeat: Infinity,
        delay: listing.delay,
        ease: "easeInOut",
      }}
    >
      <Card className={`overflow-hidden rounded-2xl backdrop-blur-md ${
        isDark
          ? "border border-white/20 bg-white/20 shadow-2xl"
          : "border border-gray-200 bg-white shadow-[0_20px_60px_rgba(100,150,255,0.25)]"
      }`}> 
        <div className={`relative h-32 bg-gradient-to-br ${listing.gradient}`}>
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.7),transparent_35%),linear-gradient(to_top,rgba(0,0,0,0.15),transparent)]" />
          <div className="absolute bottom-3 left-3 rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-gray-800">
            {listing.price}
          </div>
        </div>
        <CardContent className={`p-4 ${isDark ? "text-white" : "text-gray-800"}`}> 
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">{listing.title}</div>
              <div className={`mt-1 flex items-center gap-1 text-xs ${isDark ? "text-white/65" : "text-gray-500"}`}> 
                <Icon name="mapPin" size={12} /> {listing.location}
              </div>
            </div>
            <div className={`rounded-xl px-2 py-1 text-sm font-semibold ${isDark ? "bg-white/15 text-white" : "bg-blue-50 text-blue-600"}`}>{listing.score}</div>
          </div>
          <div className={`mt-3 flex items-center justify-between text-xs ${isDark ? "text-white/70" : "text-gray-500"}`}> 
            <span>Risk: {listing.risk}</span>
            <span>{listing.note}</span>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default function FloatingRealEstateBrowser() {
  const [theme, setTheme] = useState("light");
  const isDark = theme === "dark";
  if (!Array.isArray(listings) || listings.length === 0) {
    throw new Error("Expected at least one listing card for the floating browser mockup.");
  }

  return (
    <div className={`relative min-h-screen overflow-hidden transition-colors duration-500 ${isDark ? "bg-[#070A12] text-white" : "bg-white text-gray-900"}`}>
      <div className={`absolute inset-0 transition-opacity duration-500 ${
        isDark
          ? "bg-[radial-gradient(circle_at_50%_18%,rgba(110,130,255,0.28),transparent_34%),radial-gradient(circle_at_85%_80%,rgba(255,255,255,0.08),transparent_32%),linear-gradient(135deg,#070A12,#101522_45%,#070A12)]"
          : "bg-[radial-gradient(circle_at_50%_18%,rgba(100,150,255,0.15),transparent_40%),radial-gradient(circle_at_85%_80%,rgba(0,0,0,0.03),transparent_40%)]"
      }`} />

      <div className="pointer-events-none absolute inset-0">
        {listings.map((listing, index) => (
          <FloatingListing key={listing.title} listing={listing} index={index} theme={theme} />
        ))}
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`flex h-11 w-11 items-center justify-center rounded-2xl shadow ${isDark ? "bg-white/12" : "bg-gray-100"}`}> 
              <Icon name="home" size={22} />
            </div>
            <div>
              <div className="text-lg font-semibold tracking-tight">Truvala</div>
              <div className={`text-xs ${isDark ? "text-white/50" : "text-gray-500"}`}>AI homebuying decision browser</div>
            </div>
          </div>
          <Button
            onClick={() => setTheme(isDark ? "light" : "dark")}
            className={`rounded-full p-2 shadow ${isDark ? "bg-white/10 text-white hover:bg-white/20" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
          >
            <Icon name={isDark ? "sun" : "moon"} size={16} />
          </Button>
        </header>

        <main className="flex flex-1 items-center justify-center py-16">
          <section className={`w-full max-w-3xl rounded-[2rem] p-6 shadow-2xl backdrop-blur md:p-8 ${
            isDark
              ? "border border-white/12 bg-black/35"
              : "border border-gray-200 bg-white/80"
          }`}> 
            <div className={`mb-5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs ${
              isDark
                ? "border border-white/10 bg-white/10 text-white/70"
                : "border border-gray-200 bg-gray-50 text-gray-600"
            }`}> 
              <Icon name="sparkles" size={14} /> Search like a buyer, underwrite like an expert
            </div>

            <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">
              Find homes worth buying, not just homes for sale.
            </h1>
            <p className={`mt-5 max-w-2xl text-base leading-7 md:text-lg ${isDark ? "text-white/68" : "text-gray-600"}`}> 
              Ask for the things normal filters miss: builder history, roof age risk, bad flips,
              insurance exposure, resale strength, and hidden repair costs.
            </p>

            <div className={`mt-8 rounded-3xl p-3 shadow-lg ${
              isDark ? "border border-white/10 bg-white/10" : "border border-gray-200 bg-white"
            }`}> 
              <div className="flex flex-col gap-3 md:flex-row">
                <div className={`flex flex-1 items-center gap-3 rounded-2xl px-4 py-4 ${isDark ? "bg-black/35" : "bg-gray-50"}`}> 
                  <Icon name="search" size={20} className={isDark ? "text-white/45" : "text-gray-400"} />
                  <div className={isDark ? "text-white/78" : "text-gray-600"}>
                    Show me OC homes under $1.2M that are not obvious flips...
                  </div>
                </div>
                <Button className={isDark
                  ? "rounded-2xl bg-white px-6 py-4 text-black hover:bg-white/90 md:py-0"
                  : "rounded-2xl bg-blue-600 px-6 py-4 text-white hover:bg-blue-500 md:py-0"
                }>
                  Analyze
                </Button>
              </div>
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-4">
              {featureCards.map((feature) => (
                <div
                  key={feature.label}
                  className={`rounded-2xl p-4 text-sm ${
                    isDark
                      ? "border border-white/10 bg-white/10 text-white/72"
                      : "border border-gray-200 bg-gray-50 text-gray-600"
                  }`}
                >
                  <Icon name={feature.icon} className={isDark ? "mb-3 text-white/75" : "mb-3 text-gray-500"} size={20} />
                  {feature.label}
                </div>
              ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
