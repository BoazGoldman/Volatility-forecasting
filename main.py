from src.pipeline import run_data_pipeline
from src.features import add_log_returns
from src.model import volatility_baseline_model, garch_model
from src.evaluation import error_calculation, mae_print, rmse_print

def main():
    df = run_data_pipeline(feature_functions = [add_log_returns], timeframe = "1h")
    
    df = volatility_baseline_model(df, window_step = 480)
    
    df, _res = garch_model(df, horizon_step = 24, p = 1, o = 1, q = 1, dist = "normal", mean = "Constant")
    
    eval_df = error_calculation(df, window_step = 24, target_shift_steps = 24)
    
    print(eval_df[["timestamp", "baseline_forecast", "garch_forecast", "actual_volatility", "garch_error", "baseline_error"]].tail())
    
    mae_print(eval_df)
    rmse_print(eval_df)

if __name__ == "__main__":
    main()