package main
import (
	"bytes"
	"fmt"
	"io"
	"net/http"
)
func main() {
	body := []byte(`{"kind":"sell","sellToken":"0x19ed254efa5e061d28d84650891a3db2a9940c16","buyToken":"0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE","sellAmountBeforeFee":"1124027444655228715008","from":"0xfC3f2f30F3b31A828F0DE3565094C74a884e71c0","receiver":"0xfC3f2f30F3b31A828F0DE3565094C74a884e71c0","validFor":1800}`)
	req, _ := http.NewRequest("POST", "https://api.cow.fi/bnb/api/v1/quote", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	
	// Copy exactly what curl sends
	req.Header.Set("User-Agent", "curl/8.10.1")
	req.Header.Set("Accept", "*/*")

	client := &http.Client{}
	
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("Error:", err)
		return
	}
	defer resp.Body.Close()
	
	respBody, _ := io.ReadAll(resp.Body)
	fmt.Printf("Status: %d\nBody: %s\n", resp.StatusCode, string(respBody))
}
