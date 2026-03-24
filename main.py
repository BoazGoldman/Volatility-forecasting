from src.pipeline import run_garch_pipeline, run_cusum_pipeline

def main():
    run_garch_pipeline(symbol = "DOGE/USDT")
    
if __name__ == "__main__":
    main()